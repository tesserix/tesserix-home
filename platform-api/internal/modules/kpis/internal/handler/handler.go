// Package handler is the kpis module's HTTP surface.
//
//	GET /v1/kpis?source=<slug>    one product's headline metrics
//
// # The capability is `platform`
//
// Same gate as the other Operate reads. Deliberately NOT `billing`: a headline
// metric map is an operational view of a product, and `billing` is reserved
// for the revenue surfaces §8.2 defines.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/kpis/internal/service"
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
	{Method: http.MethodGet, Pattern: "/v1/kpis",
		handler: func(h *Handler) http.HandlerFunc { return h.read }},
}

// kpisParameters is every query parameter this route reads.
var kpisParameters = []string{"source"}

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
	if err := httpx.RejectUnknownParameters(query, kpisParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	// Required, and there is deliberately no fan-out default. Merging two
	// products' headline numbers produces a figure that describes nothing —
	// see service.Read.
	source := strings.TrimSpace(query.Get("source"))
	if source == "" {
		httpx.WriteError(w, r, httpx.BadRequest(
			"source is required: KPIs are one product's numbers, not the estate's"), h.log)
		return
	}

	metrics, err := h.svc.Read(r.Context(), federation.Operator{
		ID: principal.Subject, Capability: string(auth.CapPlatform),
	}, source)
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, metrics, h.log)
}

// writeReadError maps a failed read onto a status the console can act on.
//
// The 501/503 split is the point of this whole module, and it is worth being
// explicit about which way each error goes: "this product reports no metrics"
// must never be rendered as an outage, and an outage must never be rendered as
// "no metrics". The second mistake is the more dangerous one — it tells an
// operator a number does not exist when it exists and cannot be reached.
func (h *Handler) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrNotInstrumented):
		// 501 all the way through, so the console's own
		// `instrumentation-unavailable` state fires — the state that renders
		// "not instrumented" rather than dashes an operator reads as zeroes.
		httpx.WriteError(w, r, httpx.NotImplemented(
			"the product reports no headline metrics yet"), h.log)
	case errors.Is(err, service.ErrNoProducts):
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
	case errors.Is(err, service.ErrUnknownSource):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
	default:
		// Deliberately not err.Error(): a transport failure's text carries
		// hostnames, which is why the federation package sanitizes at all.
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product could not be reached for its headline metrics"), h.log)
	}
}
