// Package handler is the conversions module's HTTP surface.
//
//	GET /v1/conversions?source=<slug>&email=<address>
//
// # The capability is `crm`
//
// Same gate as the CRM queues, and for the same reason those chose it: this
// answers a CRM question — "did the lead we have been working become a live
// account?" — and the vocabulary already has a word for that surface. It is
// deliberately NOT `platform`, which the other federated Operate reads use:
// the caller here is the Handoff tab, an operator working leads, and gating it
// on `platform` would mean an operator who can work the CRM cannot see whether
// their own leads converted.
//
// # Every failure is a status, never a conversion
//
// The contract's `none` means "the product answered, and this person has not
// converted". There is no path through this handler on which a failed read
// produces a 200 with a state in it. That rule is the module's whole reason to
// exist; writeReadError is where it is enforced on the wire.
//
// # This route carries PII
//
// The email is a lead's address, in the QUERY STRING, and the response body
// carries the product's account label. Neither is logged here — the failure
// paths are written from this file's own strings, never from the request or
// the product's body. See sessions.go in onboardingfunnel for the same
// discipline and the reasoning behind it.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/conversions/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// Handler serves the module's routes.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

// New builds the handler.
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
// named — so the capability test can range over it rather than over a list
// someone has to remember to update.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/conversions",
		handler: func(h *Handler) http.HandlerFunc { return h.read }},
}

// readParameters is every query parameter this route reads. Anything else is a
// 400 — see httpx.RejectUnknownParameters.
var readParameters = []string{"source", "email"}

// Routes mounts the table behind the capability gate.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		mux.Handle(r.Method+" "+r.Pattern, auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapCRM, h.log, r.handler(h))))
	}
}

func (h *Handler) read(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, readParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	// Both required, and no fan-out default for either. An opportunity always
	// knows its own product, and "has this email converted anywhere" is a
	// different question with no consumer — answering it would require merging
	// two products' refs, which are opaque and product-scoped by design.
	source := strings.TrimSpace(query.Get("source"))
	if source == "" {
		httpx.WriteError(w, r, httpx.BadRequest(
			"source is required: a conversion ref is one product's, not the estate's"), h.log)
		return
	}
	email := strings.TrimSpace(query.Get("email"))
	if email == "" {
		httpx.WriteError(w, r, httpx.BadRequest("email is required"), h.log)
		return
	}

	answer, err := h.svc.Read(r.Context(), federation.Operator{
		ID: principal.Subject, Capability: string(auth.CapCRM),
	}, source, email)
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, answer, h.log)
}

// writeReadError maps a failed read onto a status the caller can act on.
//
//   - 400  the caller named a product that cannot be asked about conversions.
//   - 404  the product DECLARED `conversions` and does not mount it — the
//     over-declaration registry.go warns about. The fix is a declaration, not
//     a restart, so it must not read as a generic outage.
//   - 501  nothing on this deployment declares conversions, or the product
//     mounts the route and declines.
//   - 503  everything else: an outage, or a 200 that was not an answer.
//
// What the branches have in common matters more than what separates them: none
// writes a `state`. The console maps every non-2xx to `unknown` (Ruling 28),
// so the distinctions here are for the operator reading logs and status codes,
// not for the console's own behaviour — which is exactly why they are worth
// keeping apart rather than collapsing into one 503.
func (h *Handler) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrUnknownSource):
		// Deliberately not err.Error(): that carries the source the caller
		// named, and this response is written from our own strings only.
		httpx.WriteError(w, r, httpx.BadRequest(
			"that product cannot be asked about conversions on this deployment"), h.log)
	case errors.Is(err, service.ErrNoProducts):
		httpx.WriteError(w, r, httpx.NotImplemented(
			"no product on this deployment declares conversions"), h.log)
	case errors.Is(err, service.ErrNoConversions):
		httpx.WriteError(w, r, httpx.NotFound(
			"the product declares conversions but does not mount them"), h.log)
	case errors.Is(err, service.ErrNotImplemented):
		httpx.WriteError(w, r, httpx.NotImplemented(
			"the product reports no conversions"), h.log)
	case errors.Is(err, service.ErrUnreadable):
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product's conversion answer could not be read"), h.log)
	default:
		// A transport failure's text carries hostnames, which is why the
		// federation package sanitizes at all.
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product could not be reached for a conversion answer"), h.log)
	}
}
