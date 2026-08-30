// Package handler is the sources module's HTTP surface.
//
//	GET /v1/platform/sources    which products declare which endpoints
//
// # The capability is `platform`
//
// Same gate as the other Operate reads (kpis, koraaimetrics, inbox, entities,
// onboardingfunnel). What this route reports is the shape of the estate's
// federation configuration, which is the most platform-operational fact there
// is; a caller who may not read any federated surface has no use for the list
// of products serving them.
//
// # Why it lives under /v1/platform and takes no parameters
//
// /v1/platform is already this service's "facts about this deployment"
// namespace — /v1/platform/health is there, and it is the same kind of answer:
// something true of the deployment rather than fetched from a product.
//
// The route is unparameterised on purpose. The obvious alternative,
// `?endpoint=onboarding`, forces a decision this service cannot make honestly:
// an endpoint name it does not recognise is either a typo or an endpoint
// nobody declares, and those want opposite answers (400 versus an empty list)
// while being indistinguishable without a canonical list of endpoint names
// kept somewhere. Answering every name at once removes the question — a key is
// here because a product declared it, and a caller looking up a key it did not
// find has learned exactly the fact the registry holds.
package handler

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/sources/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
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
	{Method: http.MethodGet, Pattern: "/v1/platform/sources",
		handler: func(h *Handler) http.HandlerFunc { return h.read }},
}

// sourcesParameters is empty: this route reads none. Declared anyway, rather
// than skipping the check, so a parameter someone adds later has to be added
// here too — and so a caller sending a filter this route does not implement
// gets a 400 instead of a full list that looks like the filter matched
// everything.
var sourcesParameters = []string{}

// Routes mounts the table behind the capability gate.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		mux.Handle(r.Method+" "+r.Pattern,
			auth.Authenticate(verifier, h.log,
				auth.RequireCapability(auth.CapPlatform, h.log, r.handler(h))))
	}
}

// read answers from configuration alone. There is no failure path and no
// federated call — see the service's package doc for why that is a property of
// the question rather than an omission.
func (h *Handler) read(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.FromContext(r.Context()); !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}
	if err := httpx.RejectUnknownParameters(r.URL.Query(), sourcesParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, h.svc.Index(), h.log)
}
