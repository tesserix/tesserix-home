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
	"bytes"
	"encoding/json"
	"errors"
	"io"
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

// createGroupRequest is the create body.
type createGroupRequest struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	SortOrder *int   `json:"sort_order"`
}

func (h *Handler) createGroup(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	var request createGroupRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}
	key, err := h.readKey(r, principal, service.OpGroupCreate, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.CreateGroup(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		request.Key, request.Label, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

// updateGroupRequest is the group PATCH body.
//
// `key` is declared and REFUSED rather than omitted from the struct. Omitted,
// DisallowUnknownFields would answer "unknown field key", which reads as a
// typo; declared, the refusal can say why a key cannot be renamed and what to
// do instead.
type updateGroupRequest struct {
	Key       *string `json:"key"`
	Label     *string `json:"label"`
	SortOrder *int    `json:"sort_order"`
}

func (h *Handler) updateGroup(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	var request updateGroupRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}
	if request.Key != nil {
		h.fail(w, r, httpx.BadRequest(
			"a group's key cannot be changed: every tool in the group references it. "+
				"Add the new group, move the tools to it, then remove the old one"))
		return
	}
	key, err := h.readKey(r, principal, service.OpGroupUpdate, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	patch := service.GroupPatch{Label: request.Label, SortOrder: request.SortOrder}
	written, err := h.svc.UpdateGroup(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		r.PathValue("key"), patch, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

func (h *Handler) deleteGroup(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	key, err := h.readKey(r, principal, service.OpGroupDelete, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.DeleteGroup(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		r.PathValue("key"), key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

// maxBodyBytes caps a write. A directory entry is a few hundred bytes; this is
// generous by three orders of magnitude and still bounded.
const maxBodyBytes = 64 << 10

// beginWrite recovers the principal and reads the body once — it is needed
// twice, decoded into a request struct and digested for the idempotency key,
// and a decoder would consume the stream.
func (h *Handler) beginWrite(w http.ResponseWriter, r *http.Request) (*auth.Principal, []byte, bool) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		// Unreachable behind Authenticate. Refused rather than assumed,
		// because the alternative is an audit row with an empty actor.
		h.log.ErrorContext(r.Context(), "a write route ran without a principal",
			slog.String("path", r.URL.Path))
		h.fail(w, r, httpx.Internal("request failed"))
		return nil, nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		h.fail(w, r, httpx.BadRequest("the request body could not be read"))
		return nil, nil, false
	}
	return principal, body, true
}

// readKey turns an optional Idempotency-Key header into a key. Optional
// deliberately: no header is a normal write. A header the caller got WRONG is
// an error, because a caller who meant to be protected must be told they were
// not.
func (h *Handler) readKey(r *http.Request, principal *auth.Principal, operation string, body []byte) (*idempotency.Key, error) {
	key, asked, err := idempotency.FromRequest(r, principal.Subject, operation, body)
	if err != nil {
		return nil, err
	}
	if !asked {
		return nil, nil
	}
	return &key, nil
}

// decode parses a body, rejecting anything the struct does not declare. An
// unknown field today is a field this service might mean something by
// tomorrow; the write-side twin of RejectUnknownParameters.
func decode(body []byte, into any) error {
	if len(body) == 0 {
		return httpx.BadRequest("a request body is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return httpx.BadRequest("the request body is not the expected JSON: " + err.Error())
	}
	return nil
}

// createToolRequest is the create body. Pointers where absence is meaningful.
type createToolRequest struct {
	Name      string  `json:"name"`
	Subdomain string  `json:"subdomain"`
	Purpose   string  `json:"purpose"`
	Note      *string `json:"note"`
	GroupKey  string  `json:"group_key"`
	// Absent means "the end of its group". A non-pointer would make 0 —
	// legitimately the first position — indistinguishable from "unspecified".
	SortOrder *int `json:"sort_order"`
}

func (h *Handler) createTool(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	var request createToolRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}
	key, err := h.readKey(r, principal, service.OpToolCreate, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.CreateTool(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		domain.Tool{
			Name: request.Name, Subdomain: request.Subdomain, Purpose: request.Purpose,
			Note: request.Note, GroupKey: request.GroupKey, SortOrder: request.SortOrder,
		}, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

// updateToolRequest is the PATCH body.
//
// json.RawMessage for Note rather than *string, because THREE states have to
// be distinguishable and a pointer carries two: absent (leave it), null
// (clear it) and a string (set it). Without the raw form there is no way to
// remove a note.
type updateToolRequest struct {
	Name      *string         `json:"name"`
	Subdomain *string         `json:"subdomain"`
	Purpose   *string         `json:"purpose"`
	GroupKey  *string         `json:"group_key"`
	Note      json.RawMessage `json:"note"`
	SortOrder *int            `json:"sort_order"`
}

func (h *Handler) updateTool(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	var request updateToolRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}
	key, err := h.readKey(r, principal, service.OpToolUpdate, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	patch := service.ToolPatch{
		Name: request.Name, Subdomain: request.Subdomain, Purpose: request.Purpose,
		GroupKey: request.GroupKey, SortOrder: request.SortOrder,
	}
	// The three states, read explicitly.
	if len(request.Note) > 0 {
		if string(request.Note) == "null" {
			patch.ClearNote = true
		} else {
			var note string
			if err := json.Unmarshal(request.Note, &note); err != nil {
				h.fail(w, r, httpx.BadRequest("note must be a string or null"))
				return
			}
			patch.Note = &note
		}
	}

	written, err := h.svc.UpdateTool(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		r.PathValue("id"), patch, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

func (h *Handler) deleteTool(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	// A DELETE carries no body, so the idempotency digest is over an empty
	// one — the key plus the path is what identifies the request.
	key, err := h.readKey(r, principal, service.OpToolDelete, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.DeleteTool(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		r.PathValue("id"), key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}
