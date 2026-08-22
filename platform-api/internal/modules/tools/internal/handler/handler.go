// Package handler is the tools module's HTTP surface: the routes, the
// capability gate, and the mapping from a failure to a status code.
//
// # The surface, in full
//
//	GET    /v1/platform/tools              the whole directory
//	POST   /v1/platform/tools              add an entry
//	PATCH  /v1/platform/tools/{id}         change one
//	DELETE /v1/platform/tools/{id}         remove one
//	GET    /v1/platform/tool-groups        the headings, in display order
//	POST   /v1/platform/tool-groups        add one
//	PATCH  /v1/platform/tool-groups/{key}  change one
//	DELETE /v1/platform/tool-groups/{key}  remove one
//
// # There is no pagination, and that is a decision rather than an omission
//
// This is a fifteen-row directory that the console renders WHOLE — the home
// page shows every group and every tool at once, and the command palette
// searches across all of them. A keyset cursor over it would be ceremony that
// every caller immediately undid by paging to exhaustion. §4's pagination rule
// exists for queues that grow without bound; this list grows when somebody
// deploys a new internal tool, which is a handful of times a year.
//
// Recorded here because an unpaginated list that says nothing looks like one
// where pagination was forgotten, and the next reader would be right to
// wonder.
//
// # Every route gates on `platform`
//
// Taken from `platform.dashboard` in packages/console-core/src/routes.ts,
// which is the surface the directory is served on. There is no verb to stack:
// the vocabulary's verbs — respond, mass-send, hard-delete,
// rotate-credentials, adjust-balance, execute-refund — none of them names
// editing a directory of links. Inventing `tools-write` would assert a Zitadel
// role nobody holds, which fails closed on every real operator.
package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
)

// Handler serves the module.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Route is one of the module's paths. Write says which gate it goes behind and
// tells a test which routes carry a body.
type Route struct {
	Method  string
	Pattern string
	Write   bool
	// handler is unexported so the table stays a description of the surface
	// rather than a handle on it.
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared.
//
// Registration reads this table, so a route not in it is not served; and
// capability_test ranges over it and FAILS on an entry it has no case for, so
// a route added here without a capability case turns the suite red rather than
// passing untested.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/platform/tools",
		handler: func(h *Handler) http.HandlerFunc { return h.listTools }},
	{Method: http.MethodPost, Pattern: "/v1/platform/tools", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.createTool }},
	{Method: http.MethodPatch, Pattern: "/v1/platform/tools/{id}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.updateTool }},
	{Method: http.MethodDelete, Pattern: "/v1/platform/tools/{id}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.deleteTool }},
	{Method: http.MethodGet, Pattern: "/v1/platform/tool-groups",
		handler: func(h *Handler) http.HandlerFunc { return h.listGroups }},
	{Method: http.MethodPost, Pattern: "/v1/platform/tool-groups", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.createGroup }},
	{Method: http.MethodPatch, Pattern: "/v1/platform/tool-groups/{key}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.updateGroup }},
	{Method: http.MethodDelete, Pattern: "/v1/platform/tool-groups/{key}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.deleteGroup }},
}

// Routes mounts the table. Named Routes rather than Register because the
// module's public Register/Config file is tools.go, and it calls this.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	gate := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapPlatform, h.log, handler))
	}
	for _, route := range RouteTable {
		mux.Handle(route.Method+" "+route.Pattern, gate(route.handler(h)))
	}
}

// Neither read takes a parameter, so the allowed set is empty and ANY query
// string is refused. That is stricter than it looks and it is right: there is
// no filtering to ask for, so `?group=identity` is a caller expecting
// behaviour this endpoint does not have.
var noParameters = []string{}

func (h *Handler) listTools(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		h.fail(w, r, err)
		return
	}
	payload, err := h.svc.Tools(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) listGroups(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		h.fail(w, r, err)
		return
	}
	payload, err := h.svc.Groups(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

// fail maps a failure to a status code.
//
// Four domain outcomes, four codes, because collapsing any pair would make two
// different problems indistinguishable to a client deciding whether to retry.
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		httpx.WriteError(w, r, httpx.NotFound(unwrap(err)), h.log)
	case errors.Is(err, service.ErrConflict):
		httpx.WriteError(w, r, httpx.Conflict(unwrap(err)), h.log)
	case errors.Is(err, service.ErrRefused), errors.Is(err, domain.ErrInvalid):
		httpx.WriteError(w, r, httpx.Validation(unwrap(err), nil), h.log)
	case errors.Is(err, idempotency.ErrInvalidKey):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
	default:
		httpx.WriteError(w, r, err, h.log)
	}
}

// unwrap returns the message without the sentinel's prefix. The sentinel names
// the CLASS of failure, which the status code already carries; the message is
// the part a caller can act on.
func unwrap(err error) string {
	message := err.Error()
	for _, prefix := range []string{
		service.ErrRefused.Error() + ": ",
		service.ErrNotFound.Error() + ": ",
		service.ErrConflict.Error() + ": ",
		domain.ErrInvalid.Error() + ": ",
	} {
		if len(message) > len(prefix) && message[:len(prefix)] == prefix {
			return message[len(prefix):]
		}
	}
	return message
}

// Replaced in Task 4. A stub rather than an absent route because RouteTable is
// what registration reads, and a table that does not yet list the writes would
// make Task 4 a change to the surface rather than a filling-in of it.
func (h *Handler) createTool(w http.ResponseWriter, r *http.Request)  { h.notYet(w, r) }
func (h *Handler) updateTool(w http.ResponseWriter, r *http.Request)  { h.notYet(w, r) }
func (h *Handler) deleteTool(w http.ResponseWriter, r *http.Request)  { h.notYet(w, r) }
func (h *Handler) createGroup(w http.ResponseWriter, r *http.Request) { h.notYet(w, r) }
func (h *Handler) updateGroup(w http.ResponseWriter, r *http.Request) { h.notYet(w, r) }
func (h *Handler) deleteGroup(w http.ResponseWriter, r *http.Request) { h.notYet(w, r) }

func (h *Handler) notYet(w http.ResponseWriter, r *http.Request) {
	httpx.WriteError(w, r, httpx.Error{StatusCode: http.StatusNotImplemented,
		Code: "NOT_IMPLEMENTED", Message: "this write is not built yet"}, h.log)
}
