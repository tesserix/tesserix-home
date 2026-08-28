// Package handler is the koraaimetrics module's HTTP surface.
//
//	GET /v1/kora/ai-metrics?from=&to=&page=&limit=
//
// One named route, deliberately not /v1/products/kora/ai-metrics or a
// generic passthrough — see the package doc on koraaimetrics for why.
//
// # The capability is `platform`
//
// Same gate as the other Operate reads (kpis, inbox, entities): a
// product's AI-resolution metrics are an operational view of that product,
// not a revenue surface, so this is not gated on `billing`.
package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/koraaimetrics/internal/service"
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
	{Method: http.MethodGet, Pattern: "/v1/kora/ai-metrics",
		handler: func(h *Handler) http.HandlerFunc { return h.read }},
}

// aiMetricsParameters is every query parameter Kora's endpoint reads
// (tesserix/kora#507's parseQuery): the window and paging. Anything else is
// a 400 — see httpx.RejectUnknownParameters. Forwarded, never interpreted —
// see service.Read.
var aiMetricsParameters = []string{"from", "to", "page", "limit"}

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
	if err := httpx.RejectUnknownParameters(query, aiMetricsParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	data, pagination, err := h.svc.Read(r.Context(), federation.Operator{
		ID: principal.Subject, Capability: string(auth.CapPlatform),
	}, query)
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}

	httpx.WriteMeta(w, r, http.StatusOK, data, metaFrom(pagination), h.log)
}

// metaFrom projects Kora's §4.1 pagination block onto this service's own
// pagination channel (httpx.Meta), so a caller reading `total`/`limit` here
// finds them where every other module puts them, rather than buried inside
// an opaque `data` blob.
//
// nil in, nil out: a missing pagination block is not this handler's problem
// to invent — see service.Read's doc for why that is not fatal.
//
// `page` is deliberately NOT carried: httpx.Meta is cursor-oriented and has
// no page field, and adding one here would be inventing a channel this
// service does not otherwise have. More to the point, page is the one value
// the caller already supplied — echoing it back carries no information the
// client lacks — whereas total and limit do: Kora clamps limit to its own
// MaxLimit, so the applied value can differ from the requested one, and
// total is not something the caller could have computed itself.
func metaFrom(p *service.Pagination) *httpx.Meta {
	if p == nil {
		return nil
	}
	total := p.Total
	return &httpx.Meta{Total: &total, Limit: int(p.Limit)}
}

// writeReadError maps a failed read onto a status the console can act on.
//
// 404 and 501 are different answers from Kora and must stay distinguishable
// through this proxy: Kora deliberately answers 404 when its admin group is
// unmounted (an empty secret), so an operator can tell a missing secret from
// a wrong one, and 501 would mean the endpoint exists but declines outright.
// Collapsing either into a generic failure hides which one happened from
// whoever is debugging it — the exact mistake tesserix-home#403 calls out.
func (h *Handler) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrNotConfigured):
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
	case errors.Is(err, service.ErrUpstreamNotFound):
		httpx.WriteError(w, r, httpx.NotFound(err.Error()), h.log)
	case errors.Is(err, service.ErrUpstreamNotImplemented):
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
	default:
		// Deliberately not err.Error(): a transport failure's text carries
		// hostnames, which is why the federation package sanitizes at all.
		httpx.WriteError(w, r, httpx.Unavailable(
			"kora could not be reached for its AI metrics"), h.log)
	}
}
