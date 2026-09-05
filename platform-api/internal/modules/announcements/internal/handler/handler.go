// Package handler is the announcements module's HTTP surface.
package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/productscope"
)

// The lifecycle status a caller is asking on behalf of, when it names none.
//
// `active` matches what apps/web defaults to, so a caller that omits the
// parameter keeps seeing what it saw before the migration.
const defaultTenantStatus = "active"

var (
	errNoPrincipal     = errors.New("no principal on the request")
	errUnscopedMachine = errors.New("this caller is not configured for any product")
)

// listParameters is every parameter this route reads. Anything else is a 400.
var listParameters = []string{"tenant_status"}

type Handler struct {
	svc   *service.Service
	log   *slog.Logger
	scope *productscope.Registry
}

func New(svc *service.Service, log *slog.Logger, scope *productscope.Registry) *Handler {
	return &Handler{svc: svc, log: log, scope: scope}
}

// Routes registers the module's paths.
//
// MACHINE-ONLY, like the tickets module's create. This route answers "what
// should this product show its merchants", which is a question only a product
// asks — the console authors announcements through apps/web today, and #150
// will build its own surface rather than borrow this one.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	mux.Handle("GET /v1/announcements", auth.Authenticate(verifier, h.log,
		auth.RequireCapability(auth.CapReadAnnouncements, h.log, http.HandlerFunc(h.list))))
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, listParameters); err != nil {
		h.fail(w, r, err)
		return
	}

	// The product comes from configuration keyed by the attested subject.
	// There is deliberately no `product` parameter: one would let a caller ask
	// about an audience it is not in.
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		h.fail(w, r, errNoPrincipal)
		return
	}
	productID, scoped := h.scope.ProductFor(principal.Subject)
	if !scoped {
		// Refused, not served unscoped. An unmapped machine has no product, so
		// there is no honest set of announcements to return — and the
		// tempting fallback, "everything untargeted", would be a different
		// answer dressed as the same one.
		h.log.ErrorContext(r.Context(),
			"an announcements caller resolves to no product — PRODUCT_SCOPE_* is missing an entry for this subject",
			slog.String("subject", principal.Subject))
		h.fail(w, r, errUnscopedMachine)
		return
	}

	// NO TENANT. Announcements are a broadcast filtered by lifecycle STATUS,
	// not a per-tenant resource — which is why this does not use the tickets
	// module's tenant rule. The status is asserted by the product, the same
	// trust model as the tenant there.
	status := query.Get("tenant_status")
	if status == "" {
		status = defaultTenantStatus
	}

	payload, err := h.svc.Active(r.Context(), productID, status)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	var envelope httpx.Error
	switch {
	case errors.As(err, &envelope):
	case errors.Is(err, errUnscopedMachine), errors.Is(err, errNoPrincipal):
		// 403, for the reason the tickets module learned in production: a
		// configuration refusal reported as a fault sends an operator to the
		// database instead of to PRODUCT_SCOPE_*.
		envelope = httpx.Forbidden("this caller is not configured for any product")
	default:
		envelope = httpx.Internal("request failed")
	}
	httpx.WriteError(w, r, envelope, h.log)
}
