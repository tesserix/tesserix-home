// Package handler is the billing module's HTTP surface.
//
//	GET /v1/billing/subscriptions   every product's recurring plans
//	GET /v1/billing/trials          every product's expiring trials
//	    ?source=<slug>              narrow to one product
//	    ?limit=<n>                  rows asked of each product (default 100)
//	    ?include_stripe_managed=true  trials only; opts in rows products exclude
//
// # The capability is `billing`, and this is the first route to use it
//
// `packages/platform-auth/src/capabilities.ts` has declared `billing` since the
// vocabulary was written, marked RESERVED with the note that "the console has
// no billing surface today (0 of 28 routes)". This is that surface, so the
// reservation ends here.
//
// NOT `platform`, which every other Operate read uses. §8.2 exists to make a
// product "legible as a business", and revenue is the one estate surface where
// the capability vocabulary already drew a line — using `platform` would make
// that line decorative.
//
// The limitation worth stating rather than rediscovering: capabilities are
// estate-wide, not per-product (§7). So `billing` admits its holder to EVERY
// product's revenue, not a chosen one. That is a real consequence of turning
// this on, and it is smaller than leaving a required contract endpoint
// unreadable — but it is not nothing.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/service"
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
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/billing/subscriptions",
		handler: func(h *Handler) http.HandlerFunc { return h.subscriptions }},
	{Method: http.MethodGet, Pattern: "/v1/billing/trials",
		handler: func(h *Handler) http.HandlerFunc { return h.trials }},
}

// DefaultLimit is what each product is asked for when the caller names none.
const DefaultLimit = 100

// MaxLimit is refused rather than clamped: silently returning fewer rows than
// asked for is how a caller comes to believe a revenue page is complete.
const MaxLimit = 500

var subscriptionParameters = []string{"source", "limit"}
var trialParameters = []string{"source", "limit", "include_stripe_managed"}

// Routes mounts the table behind the capability gate.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		mux.Handle(r.Method+" "+r.Pattern,
			auth.Authenticate(verifier, h.log,
				auth.RequireCapability(auth.CapBilling, h.log, r.handler(h))))
	}
}

func (h *Handler) subscriptions(w http.ResponseWriter, r *http.Request) {
	principal, query, ok := h.begin(w, r, subscriptionParameters)
	if !ok {
		return
	}
	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Subscriptions(r.Context(), operatorFor(principal), service.Query{
		Source: strings.TrimSpace(query.Get("source")),
		Limit:  limit,
	})
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

func (h *Handler) trials(w http.ResponseWriter, r *http.Request) {
	principal, query, ok := h.begin(w, r, trialParameters)
	if !ok {
		return
	}
	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Trials(r.Context(), operatorFor(principal), service.Query{
		Source: strings.TrimSpace(query.Get("source")),
		Limit:  limit,
		// Only `true` opts in. Any other value is treated as absent rather
		// than rejected: this is a widening flag, and the safe reading of an
		// unrecognised value is the narrower result.
		IncludeStripeManaged: query.Get("include_stripe_managed") == "true",
	})
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

// begin does the checks both routes share.
func (h *Handler) begin(
	w http.ResponseWriter, r *http.Request, allowed []string,
) (*auth.Principal, url.Values, bool) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		// Fail closed, before any work — otherwise status codes alone tell an
		// unverified caller which product slugs exist.
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return nil, nil, false
	}
	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, allowed); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return nil, nil, false
	}
	return principal, query, true
}

func operatorFor(principal *auth.Principal) federation.Operator {
	return federation.Operator{
		ID: principal.Subject,
		// The capability actually exercised, so a product records that this
		// was a billing read rather than a generic platform one (§8.4).
		Capability: string(auth.CapBilling),
	}
}

func (h *Handler) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrNotInstrumented):
		// 501, never an empty 200. §8.2 forbids an empty list meaning "no
		// billing" because it is indistinguishable from "no subscriptions" —
		// and an unconfigured estate must not render as a solvent one with no
		// customers.
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
	case errors.Is(err, service.ErrUnknownSource):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
	default:
		httpx.WriteError(w, r, httpx.Unavailable("the billing sources could not be read"), h.log)
	}
}

func readLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DefaultLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, httpx.BadRequest("limit must be a positive integer")
	}
	if n > MaxLimit {
		return 0, httpx.BadRequest("limit must be " + strconv.Itoa(MaxLimit) + " or fewer")
	}
	return n, nil
}
