// Package handler is the audit module's HTTP surface.
//
//	GET /v1/audit          the estate timeline
//	    ?source=<slug>     narrow to one product
//
// # The capability is `platform`
//
// Taken from `platform.auditLog` in packages/console-core/src/routes.ts:250,
// which is the console surface this serves. Reads are gated, unlike the tools
// module's: the audit log is not rendered on every page for every operator,
// it is a Governance surface opened deliberately.
package handler

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/service"
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
	// handler is unexported so the table stays a description of the surface
	// rather than a handle on it.
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/audit",
		handler: func(h *Handler) http.HandlerFunc { return h.estate }},
}

// Routes mounts the table behind the capability gate.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		mux.Handle(r.Method+" "+r.Pattern,
			auth.Authenticate(verifier, h.log,
				auth.RequireCapability(auth.CapPlatform, h.log, r.handler(h))))
	}
}

func (h *Handler) estate(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	// The identity behind the request is read from the verified principal, not
	// from anything client-supplied. Subject is looked up before the
	// existence of the principal is asserted below, so a bad `source` still
	// answers 400 rather than being shadowed by an auth concern this route's
	// own Authenticate middleware already settled.
	var subject string
	if ok {
		subject = principal.Subject
	}

	page, err := h.svc.Estate(r.Context(), federation.Operator{
		ID:         subject,
		Capability: string(auth.CapPlatform),
	}, strings.TrimSpace(r.URL.Query().Get("source")))
	if err != nil {
		// The zero-value domain.Page{} on this path has NIL slices, which
		// serialise as null — never fall through to WriteData here.
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	}

	if !ok {
		// Unreachable behind Authenticate in production; guarded here so a
		// successful lookup can never be attributed to a caller who was
		// never verified.
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}
