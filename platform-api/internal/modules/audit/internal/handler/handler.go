// Package handler is the audit module's HTTP surface.
//
//	GET /v1/audit             the estate timeline
//	    ?source=<slug>        narrow to one product
//	    ?limit=<n>            rows asked of each product (default 200)
//	    ?since_hours=<n>      how far back each product reaches (default 720)
//
// # The capability is `platform`
//
// Taken from `platform.auditLog` in packages/console-core/src/routes.ts:250,
// which is the console surface this serves. Reads are gated, unlike the tools
// module's: the audit log is not rendered on every page for every operator,
// it is a Governance surface opened deliberately.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
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
// The bounds every product is asked for when the caller names none.
//
// The SAME numbers apps/console/lib/platform-api.ts sends as AUDIT_LIMIT and
// AUDIT_SINCE_HOURS. NOT the same as apps/web's own defaults: apps/web's
// DEFAULT_SINCE_HOURS is 24, not 720 — 720 is only apps/web's MAX_SINCE_HOURS
// ceiling. What matches here is what the console sends, not what the other
// transport defaults to when nobody asks. Defaulting rather than leaving them
// unset matters even with the console always sending them: an unbounded
// fan-out asks each product for its entire audit log, and the federation
// client truncates the answer at 1 MiB mid-JSON.
const (
	DefaultLimit      = 200
	DefaultSinceHours = 720
)

// estateParameters is every query parameter this route reads. Anything else is
// a 400 — see httpx.RejectUnknownParameters.
var estateParameters = []string{"source", "limit", "since_hours"}

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
	if !ok {
		// Fail closed, before any work. Unreachable behind Authenticate in
		// production; if this route is ever mounted without it, the refusal
		// must come before the service is touched — otherwise status codes
		// alone tell an unverified caller which product slugs exist.
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, estateParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	limit, err := readBound(query.Get("limit"), "limit", DefaultLimit)
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	sinceHours, err := readBound(query.Get("since_hours"), "since_hours", DefaultSinceHours)
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Estate(r.Context(), federation.Operator{
		ID:         principal.Subject,
		Capability: string(auth.CapPlatform),
	}, service.Query{
		Source:     strings.TrimSpace(query.Get("source")),
		Limit:      limit,
		SinceHours: sinceHours,
	})
	if err != nil {
		// The zero-value domain.Page{} on this path has NIL slices, which
		// serialise as null — never fall through to WriteData here.
		//
		// A deployment federating no products at all is 501, not a 400 and
		// not an empty 200: the console maps that status to
		// "instrumentation-unavailable", which is the honest reading of a
		// registry nobody configured. Everything else Estate refuses is a bad
		// request — today, a source that is not a product.
		if errors.Is(err, service.ErrNotInstrumented) {
			httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
			return
		}
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

// readBound parses one of the two bounds the products are asked for.
//
// Absent means the default, so a direct API caller gets the SAME window the
// console asks for rather than an unbounded read. Present-but-not-a-positive-
// integer is a 400 naming the parameter: this estate refuses parameters it
// cannot read rather than silently coercing them (#307), and a silently
// coerced `?limit=abc` is a truncated audit timeline nobody was told about.
func readBound(raw, name string, fallback int) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, httpx.Validation(name+" is not an integer", map[string]any{name: raw})
	}
	if value < 1 {
		return 0, httpx.Validation(name+" must be a positive integer", map[string]any{name: value})
	}
	return value, nil
}
