// Package handler is the tickets module's HTTP surface: parsing, capability
// gates, and the mapping from a domain failure to a status code.
//
// Under modules/tickets/internal/, so only code rooted at modules/tickets/ can
// import it.
package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
)

// Paging bounds.
//
// DefaultLimit is 50 rather than the 200 apps/web serves. That 200 is a cap
// with no pager behind it — the console fetches the first 200 tickets and
// there is no way to reach the 201st — so it is a page size chosen to hide the
// absence of paging. With a cursor there is nothing to hide, and a smaller
// page is cheaper on a shared db-f1-micro.
//
// MaxLimit exists because the limit is caller-supplied and reaches a LIMIT
// clause. Clamped rather than rejected: a caller asking for more than the
// service will serve has made a reasonable request the service is declining to
// honour in full, and the response says what it actually applied through
// `meta.limit`.
const (
	DefaultLimit = 50
	MaxLimit     = 200
)

// The dotted operation names, shared by the audit trail and the idempotency
// records so one key cannot replay another endpoint's stored response.
const (
	opReply  = "tickets.reply"
	opStatus = "tickets.status"
)

// Handler serves the module's routes.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Routes registers the module's paths onto the router.
//
// # The capabilities, and where they come from
//
// #261 split the vocabulary into surfaces (WHERE a principal works) and verbs
// (WHAT they may do). `platform.tickets` is declared as `support` in
// console-core's routes.ts, and its comment is explicit that the queue is
// "genuinely readable, and replying from it asserts its own capability at the
// action". So reads take `support` and writes take `respond`.
//
// # Why the gate is here and not only in the console
//
// #269's sharpest point. #244 put surface refusal in the console's middleware;
// if this API authorised only "is this a valid token", anything holding a
// session could call the module directly and every console restriction would
// be decoration. The API is the authorisation boundary; the console's checks
// are UX on top of it.
//
// # Why the verb is not inherited
//
// Each route names the capability it needs. #261 spent an issue undoing the
// opposite arrangement on the console side, where 11 of 14 mutating actions
// inherited the weakest gate by saying nothing.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	read := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log, auth.RequireCapability(auth.CapSupport, h.log, handler))
	}
	write := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapSupport, h.log,
				auth.RequireCapability(auth.CapRespond, h.log, handler)))
	}

	// A write requires BOTH the surface and the verb, stacked rather than
	// collapsed into one check. #261's model is that a verb layers on top of
	// surface access rather than replacing it — respond without support means
	// "may reply where they may work", not "may reply anywhere".
	mux.Handle("GET /v1/tickets", read(h.list))
	mux.Handle("GET /v1/tickets/summary", read(h.summary))
	mux.Handle("GET /v1/tickets/{id}", read(h.detail))
	mux.Handle("POST /v1/tickets/{id}/replies", write(h.reply))
	mux.Handle("PATCH /v1/tickets/{id}", write(h.setStatus))
}

// The query parameters each route admits. Anything else is a 400 — see
// httpx.RejectUnknownParameters.
//
// listParameters is every parameter `list` reads, not merely the ones the
// console currently sends: `tenant` and `cursor` are accepted here even
// though today's caller does not use them, because the allowed set tracks
// what the route reads, not what today's caller happens to send.
//
// summaryParameters is empty. The summary reads no query parameter at all —
// the console calls it as `platformRequest("tickets summary",
// "/v1/tickets/summary")`, with no query string — so any parameter on that
// route is unknown.
var (
	listParameters    = []string{"status", "priority", "product", "tenant", "limit", "cursor"}
	summaryParameters = []string{}
)

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, listParameters); err != nil {
		h.fail(w, r, err)
		return
	}

	filter := repository.Filter{
		Status:   query.Get("status"),
		Priority: query.Get("priority"),
		Product:  query.Get("product"),
		Tenant:   query.Get("tenant"),
	}
	// Validated before the query, so a typo'd filter is a 400 naming the
	// accepted values rather than an empty page indistinguishable from "no
	// tickets match".
	if filter.Status != "" {
		if _, err := domain.ParseStatus(filter.Status); err != nil {
			h.fail(w, r, httpx.Validation("status is not a ticket status", map[string]any{"status": err.Error()}))
			return
		}
	}
	if filter.Priority != "" {
		if _, err := domain.ParsePriority(filter.Priority); err != nil {
			h.fail(w, r, httpx.Validation("priority is not a ticket priority", map[string]any{"priority": err.Error()}))
			return
		}
	}

	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		h.fail(w, r, err)
		return
	}

	payload, page, err := h.svc.List(r.Context(), filter, limit, query.Get("cursor"))
	if err != nil {
		h.fail(w, r, err)
		return
	}

	preceding := page.Preceding
	total := page.Total
	httpx.WriteMeta(w, r, http.StatusOK, payload, &httpx.Meta{
		NextCursor:     page.NextCursor,
		PreviousCursor: page.PreviousCursor,
		// Addresses of the locals, not of the struct fields: taking &page.X
		// would work today and alias a value the caller can still see.
		PrecedingCount: &preceding,
		Total:          &total,
		Limit:          limit,
	}, h.log)
}

func (h *Handler) summary(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), summaryParameters); err != nil {
		h.fail(w, r, err)
		return
	}

	payload, err := h.svc.Summary(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// No meta. The summary is not a page of anything, and an empty meta object
	// would invite a client to look for pagination that does not exist.
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) detail(w http.ResponseWriter, r *http.Request) {
	payload, err := h.svc.Detail(r.Context(), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

type replyRequest struct {
	Content string `json:"content"`
	// NewStatus is the console's spelling, carried through unchanged.
	//
	// It is the one camelCase field in this API, and deliberately: it is an
	// existing request contract the console already sends, and renaming it
	// would break the migration for a consistency nobody reads. `new_status`
	// is accepted alongside it so a product written against this API's own
	// conventions is not made to learn the console's history.
	NewStatus      string `json:"newStatus"`
	NewStatusSnake string `json:"new_status"`
}

func (h *Handler) reply(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}

	var request replyRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}

	input := service.ReplyInput{Content: request.Content}
	if raw := firstNonEmpty(request.NewStatus, request.NewStatusSnake); raw != "" {
		status, err := domain.ParseStatus(raw)
		if err != nil {
			// Rejected here rather than left to the service, because the
			// transition and the reply are ONE request: an unrecognised
			// status would otherwise reject the reply along with it, after the
			// operator has typed it.
			h.fail(w, r, httpx.Validation("newStatus is not a ticket status", map[string]any{"newStatus": err.Error()}))
			return
		}
		input.NewStatus = &status
	}

	key, err := h.readKey(r, principal, opReply, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.Reply(r.Context(), actorOf(principal), r.PathValue("id"), input, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

type statusRequest struct {
	Status string `json:"status"`
}

func (h *Handler) setStatus(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}

	var request statusRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}
	status, parseErr := domain.ParseStatus(request.Status)
	if parseErr != nil {
		h.fail(w, r, httpx.Validation("status is not a ticket status", map[string]any{"status": parseErr.Error()}))
		return
	}

	key, err := h.readKey(r, principal, opStatus, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.SetStatus(r.Context(), actorOf(principal), r.PathValue("id"), status, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

// maxBodyBytes bounds a request body.
//
// A reply is capped at 10,000 characters by the domain, and this is the
// transport-level guard that stops a caller streaming a gigabyte before
// anything gets the chance to say so. Generous relative to the domain limit so
// the domain's message — which names the real limit — is the one a caller
// meets.
const maxBodyBytes = 64 << 10

// beginWrite does what both write verbs need before they diverge: recover the
// principal and read the body once.
//
// The body is read rather than streamed into a decoder because it is needed
// twice — decoded into a request struct, and digested for the idempotency key.
// A decoder consumes the stream, so the digest would be of nothing.
func (h *Handler) beginWrite(w http.ResponseWriter, r *http.Request) (*auth.Principal, []byte, bool) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		// Unreachable behind Authenticate. Refused rather than assumed,
		// because the alternative is writing an audit row with an empty actor.
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

// actorOf reduces a principal to what a reply and an audit row need.
//
// The subject and nothing else. This passed the principal's name and email
// through as well, so that displayName() could sign a reply with them; it no
// longer can, and must not. A reply is read by a MERCHANT, and a staff
// member's name and personal email address are not theirs to see — so a
// platform reply is signed "Tesserix Support" and stores no email
// (tickets/internal/service/service.go). The subject still lands in
// author_user_id, which is where internal attribution lives.
//
// auth.Principal continues to carry Name and Email, resolved from Zitadel's
// userinfo endpoint because an operator's access token carries neither claim
// (#450). This module simply has no use for them; that they now have no
// reader at all is a question for internal/platform/auth, not for here.
func actorOf(principal *auth.Principal) service.Actor {
	return service.Actor{Subject: principal.Subject}
}

// decode parses a request body, rejecting anything the struct does not
// declare.
//
// DisallowUnknownFields because a caller sending `{"contnet": "..."}` should
// be told, not answered with a 422 about an empty reply that names the wrong
// problem. It is stricter than most of the estate, and the strictness is worth
// it on a contract products pin to: an unknown field today is a field this
// service might mean something by tomorrow.
func decode(body []byte, into any) error {
	if len(body) == 0 {
		return httpx.BadRequest("a request body is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		// The parse error's text is safe to return — it describes the
		// caller's own body, not this service's internals — and without it a
		// 400 on a large payload is a guessing game.
		return httpx.BadRequest("the request body is not the expected JSON: " + err.Error())
	}
	return nil
}

func readLimit(raw string) (int, error) {
	if raw == "" {
		return DefaultLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return 0, httpx.Validation("limit is not a number", map[string]any{"limit": raw})
	}
	if limit < 1 {
		// Rejected rather than clamped up. Asking for zero rows is a bug in
		// the caller — most likely an uninitialised variable — and silently
		// serving 50 would hide it.
		return 0, httpx.Validation("limit must be at least 1", map[string]any{"limit": raw})
	}
	if limit > MaxLimit {
		return MaxLimit, nil
	}
	return limit, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// fail maps an error to a response and logs what the client is not told.
//
// The mapping is the whole reason the layers below return sentinels rather
// than formatted strings: four different failures answer with four different
// statuses, and a handler deciding that by matching on message text is one
// rewording away from turning a 404 into a 500.
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	var envelope httpx.Error
	switch {
	case errors.As(err, &envelope):
		// Already a decided answer — a validation failure from parsing above.

	case errors.Is(err, repository.ErrNotFound):
		envelope = httpx.NotFound("no such ticket")

	case errors.Is(err, paging.ErrMalformedCursor):
		// 400, not a silent first page. The cursor came off a URL, so this is
		// a bad LINK rather than a flaky read, and the two want opposite
		// advice: retrying this one can never work.
		envelope = httpx.BadRequest("the cursor could not be read; start from the first page")

	case errors.Is(err, idempotency.ErrInvalidKey):
		envelope = httpx.BadRequest("the " + idempotency.Header + " header is not usable")

	case errors.Is(err, idempotency.ErrKeyReused):
		// 409, not a replay of the stored response. The bodies differ, so
		// replaying would silently discard the second request.
		envelope = httpx.Conflict("this " + idempotency.Header + " was already used for a different request")

	case errors.Is(err, service.ErrRefused):
		// 422: understood, and declined. Distinct from 400 — the request was
		// well-formed — and the message is the domain's own, which names what
		// it declined.
		envelope = httpx.Validation(refusalMessage(err), nil)

	default:
		envelope = httpx.Internal("request failed")
	}

	// Logged at every level, because the client is deliberately told less than
	// the log knows — a driver error's text must never reach a response, and
	// an operator holding the request id needs exactly that text.
	level := slog.LevelWarn
	if envelope.StatusCode >= http.StatusInternalServerError {
		level = slog.LevelError
	}
	h.log.Log(r.Context(), level, "request failed",
		slog.Any("error", err),
		slog.String("path", r.URL.Path),
		slog.String("method", r.Method),
		slog.Int("status", envelope.StatusCode),
	)
	httpx.WriteError(w, r, envelope, h.log)
}

// refusalMessage strips the sentinel's own prefix so the caller reads the
// domain's reason rather than "the request was refused: the request was
// refused: …".
func refusalMessage(err error) string {
	message := err.Error()
	const prefix = "the request was refused: "
	if len(message) > len(prefix) && message[:len(prefix)] == prefix {
		return message[len(prefix):]
	}
	return message
}
