// Package handler is the onboardingfunnel module's HTTP surface.
//
//	GET /v1/onboarding/funnel?source=<slug>&created_from=&created_to=
//
// # The capability is `platform`
//
// Same gate as the other Operate reads (kpis, koraaimetrics, inbox, entities).
// Deliberately NOT `billing`: where signups stall is an operational question
// about a product's funnel, and `billing` is reserved for the revenue surfaces
// §8.2 defines. A funnel that ends in a paid conversion is still not a revenue
// surface, and this route is not the one that should first claim a capability
// still marked RESERVED in platform-auth's capabilities.ts.
//
// # Every failure is a status, never a funnel
//
// tesserix-home#404: "a stage with zero is a measurement; a funnel that could
// not be read is not". writeReadError below is where that rule is enforced on
// the wire — there is no path through this handler on which a failed read
// produces a 200 with a `data` object, empty or otherwise.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/onboardingfunnel/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// Handler serves the module.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Route is one of the module's paths.
type Route struct {
	Method  string
	Pattern string
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
//
// One route, not two. mark8ly also serves /admin/onboarding/sessions, and it
// is deliberately NOT federated here — see the package doc on onboardingfunnel
// for why, and for what would change that.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/onboarding/funnel",
		handler: func(h *Handler) http.HandlerFunc { return h.read }},
}

// funnelParameters is every query parameter this route reads: the source, plus
// the window mark8ly's funnel handler itself parses (created_from,
// created_to). Anything else is a 400 — see httpx.RejectUnknownParameters.
//
// The window pair is forwarded, never interpreted: the response echoes the
// EFFECTIVE window back, and that echo is only true if this layer did not
// quietly rewrite what it asked for.
var funnelParameters = []string{"source", "created_from", "created_to"}

// Routes mounts the table behind the capability gate.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		mux.Handle(r.Method+" "+r.Pattern,
			auth.Authenticate(verifier, h.log,
				auth.RequireCapability(auth.CapPlatform, h.log, r.handler(h))))
	}
}

func (h *Handler) read(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, funnelParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	// Required, and there is deliberately no fan-out default — see
	// service.Read. Merging two products' funnels needs a third vocabulary
	// that is neither product's, which is the drift #404's first rule exists
	// to prevent.
	source := strings.TrimSpace(query.Get("source"))
	if source == "" {
		httpx.WriteError(w, r, httpx.BadRequest(
			"source is required: a funnel is one product's stages, not the estate's"), h.log)
		return
	}

	// Only the window reaches the product. `source` addressed this hop and
	// means nothing to mark8ly; forwarding it would be an unknown parameter at
	// the far end.
	upstream := query
	upstream.Del("source")

	funnel, err := h.svc.Read(r.Context(), federation.Operator{
		ID: principal.Subject, Capability: string(auth.CapPlatform),
	}, source, upstream)
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, funnel, h.log)
}

// writeReadError maps a failed read onto a status the console can act on.
//
// Four distinct answers, kept apart on purpose:
//
//   - 400  the caller named a product that cannot be asked for a funnel.
//   - 404  the product DECLARED `onboarding` and does not mount it — the
//     over-declaration registry.go warns about, a permanent red source rather
//     than a visibly missing one. An operator needs to see that, not a
//     generic failure, because the fix is a declaration, not a restart.
//   - 501  nothing on this deployment declares a funnel, or the product
//     mounts the route and declines. Both are "there is no funnel to show",
//     which is a different sentence from "we could not read the funnel".
//   - 503  everything else: an outage, or a 200 whose body did not satisfy
//     the funnel's invariants. Unreadable, in both cases.
//
// What every branch has in common is more important than what separates them:
// none of them writes a `data` object. A funnel that could not be read is not
// a funnel of zeros, and there is no status here that lets it become one.
func (h *Handler) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrUnknownSource):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
	case errors.Is(err, service.ErrNoProducts):
		httpx.WriteError(w, r, httpx.NotImplemented(
			"no product on this deployment declares an onboarding funnel"), h.log)
	case errors.Is(err, service.ErrNoFunnel):
		httpx.WriteError(w, r, httpx.NotFound(
			"the product declares an onboarding funnel but does not mount one"), h.log)
	case errors.Is(err, service.ErrNotImplemented):
		httpx.WriteError(w, r, httpx.NotImplemented(
			"the product reports no onboarding funnel"), h.log)
	case errors.Is(err, service.ErrUnreadable):
		// 503, not 200-with-nothing. The product answered, but not with
		// something this service is willing to call a funnel, and the
		// difference between that and real zeroes is the whole point.
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product's onboarding funnel could not be read"), h.log)
	default:
		// Deliberately not err.Error(): a transport failure's text carries
		// hostnames, which is why the federation package sanitizes at all.
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product could not be reached for its onboarding funnel"), h.log)
	}
}
