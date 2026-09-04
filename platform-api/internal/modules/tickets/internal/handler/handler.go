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
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/productscope"
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
	opCreate = "tickets.create"
	opReply  = "tickets.reply"
	opStatus = "tickets.status"
)

// Refusals raised before the service is reached.
//
// errUnscopedMachine is a 403 rather than a 500 even though it is caused by
// configuration: the caller genuinely may not do this, and telling it "server
// error" would send an operator looking at the database instead of at
// PRODUCT_SCOPE_*. The log line, which names the subject, is where the cause
// goes.
var (
	errNoPrincipal     = errors.New("no principal on the request")
	errUnscopedMachine = errors.New("this caller is not configured for any product")
)

// Handler serves the module's routes.
type Handler struct {
	svc *service.Service
	log *slog.Logger
	// scope maps an attested subject to the product it speaks for. Never nil
	// in a wired deployment; a nil registry resolves nobody, which refuses
	// every machine rather than admitting one unscoped.
	scope *productscope.Registry
}

func New(svc *service.Service, log *slog.Logger, scope *productscope.Registry) *Handler {
	return &Handler{svc: svc, log: log, scope: scope}
}

// scopeFor resolves what the caller may reach.
//
// Registry FIRST, capability second. A subject named in the registry is a
// product's machine and is confined to that product whatever else it holds —
// so a machine that also acquired an operator capability does not thereby
// escape its scope.
//
// A caller holding product-support and resolving to NO product is REFUSED, not
// admitted unscoped. That is the one dangerous default in this design: Scope's
// zero value means "the estate", so falling through to it here would turn a
// missing config line into estate-wide access for a product's machine.
func (h *Handler) scopeFor(r *http.Request) (service.Scope, error) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		return service.Scope{}, errNoPrincipal
	}
	if slug, scoped := h.scope.ProductFor(principal.Subject); scoped {
		return service.Scope{ProductID: slug}, nil
	}
	if principal.Has(auth.CapProductSupport) {
		h.log.ErrorContext(r.Context(),
			"a product-support caller resolves to no product — PRODUCT_SCOPE_* is missing an entry for this subject",
			slog.String("subject", principal.Subject),
			slog.String("path", r.URL.Path),
		)
		return service.Scope{}, errUnscopedMachine
	}
	// An operator. Unscoped, exactly as before #152.
	return service.Scope{}, nil
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
	// A read is reachable two ways: an OPERATOR through the console's support
	// surface, and a PRODUCT'S MACHINE through product-support. Neither
	// implies the other (capabilities.ts), so this is "either", not "both".
	// WHICH tickets each then sees is not decided here — see scopeFor.
	read := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireAnyCapability(
				[]auth.Capability{auth.CapSupport, auth.CapProductSupport}, h.log, handler))
	}

	// A reply is the one write a product may make, and the two principals earn
	// it differently: an operator by holding the surface AND the verb, a
	// machine by holding product-support alone.
	//
	// The machine is NOT made to hold `respond`. That verb means "may answer
	// merchants anywhere" — granting an estate-wide verb to obtain a
	// product-scoped write is the over-grant #152 exists to avoid.
	//
	// This route was deliberately closed to machines until a reply could carry
	// an author. It can be opened now because service.authorFor exists: a
	// machine's reply is recorded as the MERCHANT it names, not as the support
	// team. Opening it before that would have filed a merchant's words under
	// the platform's name on the thread that merchant reads.
	reply := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log, byPrincipal(
			auth.RequireCapability(auth.CapProductSupport, h.log, handler),
			auth.RequireCapability(auth.CapSupport, h.log,
				auth.RequireCapability(auth.CapRespond, h.log, handler)),
		))
	}

	// Filing is MACHINE-ONLY, and that is a faithful copy rather than a
	// restriction invented here: apps/web's internal create route is the
	// product channel, and no console surface files a ticket. An operator has
	// no queue of their own to file into either — the product and tenant come
	// from the scope, and an operator has neither.
	//
	// Additive if that changes: an operator create would need a product in the
	// request, which is a different contract, not a wider gate on this one.
	machineOnly := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapProductSupport, h.log, handler))
	}

	// The summary stays OPERATOR-ONLY.
	//
	// It is a standing count with no tenant dimension, and a product caller is
	// confined to one tenant — so there is no honest answer to give one. No
	// product asks for it either: mark8ly's client lists, reads, replies and
	// files, and never fetches a summary.
	summaryOnly := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapSupport, h.log, handler))
	}

	// Remaining writes stay OPERATOR-ONLY.
	//
	// A product machine deliberately does NOT reach the reply route yet, even
	// though `product-support` is meant to carry that write, and the reason is
	// authorship rather than authorisation.
	//
	// service.Reply records every reply as domain.AuthorOperator signed
	// "Tesserix Support" (see Actor.displayName). That is correct while the
	// only caller is the console — a merchant is talking to the platform and
	// the platform is what the reply should say — and displayName's own
	// comment records the assumption it rests on: "a merchant's own replies do
	// not come through here". Admitting a machine BREAKS that assumption,
	// because a product's machine relays a MERCHANT. apps/web's route writes
	// author_type "merchant" with the merchant's own name and id
	// (app/api/internal/platform-tickets/[id]/replies/route.ts).
	//
	// So opening this route without first giving a reply an author would file
	// every merchant's words under the support team's name, on a thread that
	// merchant reads. Refusing is the safe half of the change; the author
	// contract is its own piece of work, and #152 step 2 cannot repoint
	// mark8ly's replies until it lands., unchanged by #152. mark8ly
	// cannot re-status a ticket through apps/web today and does not gain the
	// ability by moving; a merchant-side reopen is decided by the server on
	// reply, never asserted by the caller.
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
	mux.Handle("POST /v1/tickets", machineOnly(h.create))
	mux.Handle("GET /v1/tickets/summary", summaryOnly(h.summary))
	mux.Handle("GET /v1/tickets/{id}", read(h.detail))
	mux.Handle("POST /v1/tickets/{id}/replies", reply(h.reply))
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

	scope, err := h.scopeFor(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// The tenant a product caller is acting for. An operator names none and
	// stays estate-wide; a machine that names none is refused rather than
	// handed every tenant inside its product.
	scope, err = scope.ForTenant(query.Get("tenant"))
	if err != nil {
		h.fail(w, r, err)
		return
	}

	payload, page, err := h.svc.List(r.Context(), scope, filter, limit, query.Get("cursor"))
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

	scope, err := h.scopeFor(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	payload, err := h.svc.Summary(r.Context(), scope)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// No meta. The summary is not a page of anything, and an empty meta object
	// would invite a client to look for pagination that does not exist.
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) detail(w http.ResponseWriter, r *http.Request) {
	scope, err := h.scopeFor(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	scope, err = scope.ForTenant(r.URL.Query().Get("tenant"))
	if err != nil {
		h.fail(w, r, err)
		return
	}

	payload, err := h.svc.Detail(r.Context(), scope, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

type replyRequest struct {
	Content string `json:"content"`
	// TenantID is the tenant a product caller is acting for. Required of a
	// machine, meaningless for an operator — the same shape apps/web's route
	// takes, and the reason its cross-tenant guard exists.
	TenantID string `json:"tenant_id"`
	// The merchant a product is relaying. snake_case, this API's spelling —
	// mark8ly's client is being rewritten against this contract anyway, so
	// there is no existing caller whose spelling has to be honoured.
	AuthorName   string `json:"author_name"`
	AuthorEmail  string `json:"author_email"`
	AuthorUserID string `json:"author_user_id"`
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

	scope, err := h.scopeFor(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	scope, err = scope.ForTenant(request.TenantID)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	input := service.ReplyInput{Content: request.Content}
	// Only a scoped caller relays a merchant. An operator sending author
	// fields is refused by authorFor rather than ignored here, so forging a
	// merchant's message is an error the caller sees, not a silent no-op.
	if !scope.Unscoped() || request.AuthorName != "" || request.AuthorEmail != "" || request.AuthorUserID != "" {
		input.Author = &service.Author{
			Name:   request.AuthorName,
			Email:  request.AuthorEmail,
			UserID: request.AuthorUserID,
		}
	}
	if raw := firstNonEmpty(request.NewStatus, request.NewStatusSnake); raw != "" {
		// A SCOPED caller may not carry a transition on its reply.
		//
		// Without this the reply path would be a way around the operator-only
		// PATCH gate: a machine cannot re-status a ticket directly, so it must
		// not be able to do it by attaching the same transition to a message.
		//
		// It costs mark8ly nothing — its client sends no status today, and the
		// merchant-side reopen it relies on is decided by the SERVER on reply,
		// not asserted by the caller.
		if !scope.Unscoped() {
			h.fail(w, r, httpx.Validation(
				"a product caller may not set a ticket's status",
				map[string]any{"newStatus": "only an operator may transition a ticket"}))
			return
		}
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

	written, err := h.svc.Reply(r.Context(), scope, actorOf(principal), r.PathValue("id"), input, key)
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
// auth.Principal no longer carries a name or an email at all. Removing the
// last reader here was what left the userinfo lookup behind #450 with nothing
// to feed, so the resolver and both fields went; the reasoning is written out
// on auth.Principal. There is nothing left for this function to pass through
// even if it wanted to.
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

// byPrincipal sends a request to the machine gate when the caller holds
// product-support, and to the operator gate otherwise.
//
// A branch rather than a widened capability list, because the two paths are
// genuinely different policies — one capability versus a surface AND a verb —
// and RequireAnyCapability over all three would admit an operator holding
// `support` without `respond`, quietly loosening the write gate #261 put there.
//
// An unauthenticated request takes the OPERATOR branch, which then refuses it
// for having no principal. The machine branch must never be the fallback: it
// is the one with the weaker check.
func byPrincipal(machine, operator http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := auth.FromContext(r.Context()); ok && p.Has(auth.CapProductSupport) {
			machine.ServeHTTP(w, r)
			return
		}
		operator.ServeHTTP(w, r)
	})
}

// createRequest is a product filing a ticket for one of its merchants.
//
// There is deliberately no product field. The product comes from the scope the
// registry resolved, so a caller cannot file into another product's queue —
// which is the whole reason the registry exists.
type createRequest struct {
	TenantID          string `json:"tenant_id"`
	Subject           string `json:"subject"`
	Description       string `json:"description"`
	Priority          string `json:"priority"`
	SubmittedByName   string `json:"submitted_by_name"`
	SubmittedByEmail  string `json:"submitted_by_email"`
	SubmittedByUserID string `json:"submitted_by_user_id"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}

	var request createRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}

	scope, err := h.scopeFor(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	scope, err = scope.ForTenant(request.TenantID)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	key, err := h.readKey(r, principal, opCreate, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.Create(r.Context(), scope, actorOf(principal), service.CreateInput{
		Subject:           request.Subject,
		Description:       request.Description,
		Priority:          request.Priority,
		SubmittedByName:   request.SubmittedByName,
		SubmittedByEmail:  request.SubmittedByEmail,
		SubmittedByUserID: request.SubmittedByUserID,
	}, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}
