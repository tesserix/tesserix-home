// Package handler is the tenants module's HTTP surface.
//
//	GET /v1/tenants           the estate tenant directory
//	    ?source=<slug>        narrow to one product
//	    ?q=<text>             free-text search, passed through to each product
//	    ?status=<status>      the product's own status vocabulary
//	    ?limit=<n>            rows asked of each product (default 100)
//
// # The capability is `platform`
//
// Tenants sits in the platform rail's Operate group, alongside the audit log
// and identity lookup, and is gated the same way. It is deliberately NOT
// `billing`: knowing a tenant exists is an operate concern, and only what they
// pay is a revenue one.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tenants/internal/service"
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

// MaxLimit bounds what a caller may ask each product for. A request above it
// is REFUSED rather than clamped: silently returning fewer rows than asked for
// is how a caller comes to believe a page is complete when it is not.
const MaxLimit = 500

// estateParameters is every query parameter this route reads. Anything else is
// a 400 — see httpx.RejectUnknownParameters. A rejected typo is cheaper than a
// filter that silently did nothing.
var estateParameters = []string{"source", "q", "status", "limit"}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/tenants",
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

	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Estate(r.Context(), federation.Operator{
		ID: principal.Subject,
		// The operator's authority, taken from the verified session and never
		// from anything the client supplied. It is signed into every federated
		// request, so a product records who acted rather than "the platform".
		Capability: string(auth.CapPlatform),
	}, service.Query{
		Source: strings.TrimSpace(query.Get("source")),
		Q:      strings.TrimSpace(query.Get("q")),
		Status: strings.TrimSpace(query.Get("status")),
		Limit:  limit,
	})
	if err != nil {
		// "No products configured" is 501, not an empty 200: the console reads
		// it as instrumentation-unavailable rather than as "the estate has no
		// tenants", which are very different claims.
		if errors.Is(err, service.ErrNotInstrumented) {
			httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
			return
		}
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

// readLimit parses the per-product bound.
//
// Absent means the service's default, so a direct API caller gets the same
// bounded read the console asks for rather than an unbounded fan-out. Present
// but not a positive integer is a 400 rather than a silent fallback: a caller
// who sent `limit=abc` has a bug, and answering it with the default hides it.
func readLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, httpx.BadRequest("limit must be a positive integer")
	}
	if n > MaxLimit {
		return 0, httpx.BadRequest("limit exceeds the maximum of " + strconv.Itoa(MaxLimit))
	}
	return n, nil
}
