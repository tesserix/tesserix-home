// Package handler is the CRM queues module's HTTP surface: the query grammar,
// the capability gates, and the mapping from a failure to a status code.
//
// Under modules/crm/internal/, so only code rooted at modules/crm/ can import
// it.
//
// # The query grammar, in full
//
//	GET /v1/crm/queues/due
//	GET /v1/crm/queues/drifting
//
//	product          exact match on the opportunity's product
//	product_unset    true  → only rows with NO product assigned
//	stage            one of new | contacted | qualified
//	owner            case-insensitive substring match on the owner
//	country          exact match, upper-case ISO 3166-1 alpha-2
//	country_unset    true  → only rows whose organisation has no derived country
//	followers        one of under1k | k1to10k | over10k
//	followers_unset  true  → only rows whose primary contact has no follower count
//	limit            page size, 1..200, default 50, clamped up at 200
//	cursor           an opaque keyset cursor from a previous response's meta
//	                 ON THIS SAME QUEUE — a due cursor is refused by the
//	                 drifting queue and the other way round, see queue.shape
//	stale_days       drifting only: days of silence before a lead drifts (default 14)
//
// # Absence is a sibling flag, not a value
//
// The console spells absence with sentinels INSIDE the axis —
// `UNASSIGNED_PRODUCT` is "__unassigned__", `UNKNOWN_COUNTRY` and
// `UNKNOWN_FOLLOWERS` are "__unknown__" (apps/console/lib/db/crm-filters.ts).
// Those are the filter bar's vocabulary: Radix's Select cannot hold an
// empty-string item value, so the option needs SOME string. domain.Match
// records at length why that is right there and wrong here; the short version
// is that `product` is a text column, so "__unassigned__" is a value a row
// could legitimately carry, and a sentinel that can collide with real data has
// no spelling that fixes it.
//
// So absence is `<axis>_unset=true`, uniformly. The console's translation is
// one function beside crm-filters.ts — sentinel in, `_unset=true` out — and
// the band NAMES are byte-identical on both sides precisely so that ONLY
// absence needs translating.
//
// # `stage` names OPEN stages only, and a terminal one is refused
//
// `won` and `lost` are stages of an opportunity, but they are not values this
// filter accepts: both queues exclude terminal deals by their own predicate,
// so `?stage=won` is a request that can never match. It answers 422 rather
// than an empty page — the same rule as a misspelled parameter, a sentinel
// band or a negative staleness window, and for the same reason, that a silent
// success hides a caller bug. The console never sends one either; its filter
// bar is built from `CRM_STAGES.filter(s => s !== "won" && s !== "lost")`
// (apps/console/.../crm/page.tsx:162). domain.queueStages carries the argument
// and owns the accepted list, so the error enumerates exactly the three
// spellings this comment does.
//
// # The grammar is asymmetric, and the asymmetry is the schema's
//
// `product`, `country` and `followers` have an `_unset` sibling. `stage` and
// `owner` do NOT. That is not an oversight:
//
//   - `stage` is NOT NULL. There is no absent stage to select.
//   - `owner` is nullable, but there is no "unassigned owner" concept: the
//     console offers no such filter option, and a queue of unowned leads is a
//     product decision nobody has made. Adding it later is an additive wire
//     change, which is the right shape for a decision that has not been taken
//     yet — pre-building it here would ship a filter with no meaning attached.
//
// # An empty value means NO FILTER
//
// `?product=` and `?country=` and `?followers=` are all "no filter on this
// axis", identical to omitting the parameter. domain.Is("") collapses to
// Any() by construction, and this is the contract SAYING so rather than
// leaving it to be discovered: a caller sending an empty string in the hope of
// selecting rows with no product gets every row, and wants `product_unset=true`.
// It matches the console's falsy check, so the translation stays one function.
//
// # What an error's `details` carries
//
// A key is a REQUEST PARAMETER and its value is the offending input, verbatim.
// The explanation is the `message`. One key is not a parameter — `accepted`,
// a JSON array of the values the endpoint would have taken — and it is there
// because "what should I have sent" is the only part of a refusal a client can
// act on programmatically.
//
// `details` is machine-readable and it is in the golden files, so it is a
// contract. Before this rule the module had three readings of it in three
// places, including one key called `filter` whose value was a sentence with a
// Go slice rendered inside it. §1 of docs/PLATFORM-API-CONVENTIONS.md carries
// the rule now; filterRefusal and httpx.RejectUnknownParameters are where it is
// applied. The tickets module has not been converted — it answers
// `{"status": "<explanation>"}` — and that divergence is recorded in the same
// section rather than fixed here, because it is its own commit.
//
// # These routes take no request body
//
// Both are reads, so there is no JSON to decode strictly. The equivalent
// strictness for a read is `httpx.RejectUnknownParameters`: a caller sending
// `?stge=new` is told, rather than answered with an unfiltered queue reported
// as a success. That is the same failure DisallowUnknownFields exists to
// prevent, in the place a read can make it.
package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
)

// opNextAction is the dotted operation name, shared by the audit trail and the
// idempotency records so a key minted here cannot replay another endpoint's
// stored response.
const opNextAction = "crm.next_action.set"

// maxBodyBytes bounds a request body.
//
// The note is capped at domain.MaxNextActionNoteLength characters, and this is
// the transport-level guard that stops a caller streaming a gigabyte before
// anything gets the chance to say so. Generous relative to the domain limit so
// the domain's message — which names the real limit — is the one a caller
// meets.
const maxBodyBytes = 64 << 10

// Paging bounds. The same numbers as the tickets module, and the same
// reasoning: a page size chosen for a shared db-f1-micro, and a cap that
// exists because the value is caller-supplied and reaches a LIMIT clause.
//
// Clamped UP rather than rejected: a caller asking for more than the service
// will serve has made a reasonable request the service is declining to honour
// in full, and `meta.limit` says what was actually applied. A limit below 1 IS
// rejected — asking for zero rows is a caller bug, most likely an
// uninitialised variable, and quietly serving 50 would hide it.
const (
	DefaultLimit = 50
	MaxLimit     = 200
)

// The drifting queue's staleness window.
//
// DefaultStaleDays is the console's DRIFT_DAYS (apps/console/lib/crm.ts) —
// "a guess about sales rhythm, not a measured threshold". Duplicated rather
// than shared because there is nothing to share it through, and it is a
// DEFAULT rather than a rule: a caller that disagrees passes its own, which is
// exactly why the parameter exists.
//
// MaxStaleDays is an upper bound on a value that reaches make_interval. Ten
// years of silence is already every row the queue could ever hold, so anything
// beyond it is a caller bug rather than a question — and unlike `limit`, this
// one is REJECTED rather than clamped, because clamping a window would answer
// a different question from the one asked and report it as a success.
const (
	DefaultStaleDays = 14
	MaxStaleDays     = 3650
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
// # The capability, and where it comes from
//
// `crm`. Taken from packages/console-core/src/routes.ts, which declares it on
// every CRM surface (`platform.crm`, `platform.crmOrganisations`,
// `platform.crmImport`, `platform.crmSuppressions`). §7 is explicit that a
// module inventing its own would be a second vocabulary.
//
// # Why the gate is here and not only in the console
//
// The API is the authorisation boundary; #244 put surface refusal in the
// console's middleware, and if this service authorised only "is this a valid
// token", anything holding a session could call the module directly and every
// console restriction would be decoration.
//
// # Nothing is inherited, and the write has NO VERB TO INHERIT
//
// Each route names what it needs. Both queues are reads, so both name `crm`
// and no verb — a queue is genuinely readable by anyone who works the CRM
// surface.
//
// The next-action write names `crm` and no verb EITHER, and that is a finding
// rather than an oversight. §7's model is that a verb LAYERS on a surface —
// the tickets module stacks `respond` on `support` — but the CRM has no write
// verb to stack. console-core's routes.ts declares `capability: "crm"` and
// nothing else on all four CRM surfaces (`platform.crm`, `platform.crmImport`,
// `platform.crmSuppressions`, `platform.crmOrganisations`), and the console's
// own scheduleNextAction asserts exactly `{ capability: "crm" }`
// (crm/[organisation]/actions.ts:139) with no second check. The verbs that
// DO exist in the vocabulary — `respond`, `mass-send`, `hard-delete`,
// `rotate-credentials`, `adjust-balance`, `execute-refund` — none of them
// names scheduling a follow-up.
//
// So this route gates on `crm` alone. Inventing a `crm-write` here would be a
// second vocabulary, gate an operator the console lets through, and — because
// the strings are a contract with Zitadel's role keys — assert a role nobody
// holds, which fails closed on every real operator. If the CRM should have a
// write verb, it is decided in capabilities.ts and Zitadel first, and this
// line changes after. Written down so the next reader knows the gate is thin
// on purpose and where the decision belongs.
//
// The stacking is still spelled out below rather than collapsed, so adding the
// verb when it exists is one argument rather than a restructuring.
//
// Named Routes rather than Register: the module's public Register/Config file
// is crm.go, and it calls this.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	read := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log, auth.RequireCapability(auth.CapCRM, h.log, handler))
	}
	write := func(handler http.HandlerFunc) http.Handler {
		// The surface, and — when the vocabulary grows one — its verb, stacked
		// on top rather than replacing it. See the comment above.
		return auth.Authenticate(verifier, h.log, auth.RequireCapability(auth.CapCRM, h.log, handler))
	}

	// Driven from RouteTable rather than three literal mux.Handle calls, so
	// the list of routes is a value the capability test can range over. See
	// RouteTable for why that matters.
	for _, route := range RouteTable {
		gate := read
		if route.Write {
			gate = write
		}
		mux.Handle(route.Method+" "+route.Pattern, gate(route.handler(h)))
	}
}

// Route is one of the module's paths.
//
// Write says which gate it goes behind. Today both gates assert the same
// capability — the CRM has no write verb to stack, per the finding above — so
// the flag is what keeps the distinction expressible for the day it does, and
// it is also what tells a test which routes carry a body.
type Route struct {
	Method  string
	Pattern string
	Write   bool
	// handler is unexported so the table stays a description of the surface
	// rather than a handle on it: a caller outside this package can read what
	// is served, not reach into it.
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and it is the ONLY place they
// are declared.
//
// # Why a table rather than three mux.Handle lines
//
// §9 and #269 require that every route refuse a principal without the `crm`
// capability, and that the same request WITH it succeeds. A test that
// hardcoded today's three routes would satisfy both on the day it was written
// and then silently stop covering the module: a fourth route added next
// quarter would be gated by whatever its author copied, and nothing would
// notice if that was nothing.
//
// So the enumeration is fail-closed in both directions. Registration reads
// this table, so a route that is not in it is not served at all; and the
// capability test ranges over this table and FAILS on an entry it has no
// request for, so a route added here without a capability case turns the suite
// red rather than passing untested.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/crm/queues/due",
		handler: func(h *Handler) http.HandlerFunc { return h.due }},
	{Method: http.MethodGet, Pattern: "/v1/crm/queues/drifting",
		handler: func(h *Handler) http.HandlerFunc { return h.drifting }},
	// PUT rather than PATCH: the two fields are ONE thing — the next action —
	// and this replaces it wholly. An absent field is a cleared field, which
	// is a contract a PATCH could not honestly claim.
	{Method: http.MethodPut, Pattern: "/v1/crm/opportunities/{id}/next-action", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.setNextAction }},
}

// nextActionRequest is the write's body.
//
// Both fields are pointers so "absent" and "null" reach the handler as the
// same thing — nil — which is what PUT means here: whatever you do not send is
// cleared. A non-pointer `at` could not express clearing at all, since the
// zero time is a real instant.
type nextActionRequest struct {
	// At is RFC 3339. encoding/json parses it into time.Time and refuses
	// anything else, so a badly-spelled date is a 400 naming the field rather
	// than a silently ignored parameter.
	At *time.Time `json:"at"`
	// Note is the reminder text.
	Note *string `json:"note"`
}

func (h *Handler) setNextAction(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}

	var request nextActionRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}

	key, err := h.readKey(r, principal, opNextAction, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.SetNextAction(r.Context(),
		service.Actor{Subject: principal.Subject},
		r.PathValue("id"),
		domain.NextAction{At: request.At, Note: request.Note},
		key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// written.Body is already JSON — it may have been stored for replay inside
	// the transaction that produced it — and json.RawMessage passes through
	// the envelope unchanged.
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

// beginWrite recovers the principal and reads the body once.
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

// readKey turns an optional Idempotency-Key header into a key.
//
// Optional, deliberately: no header is a normal write, not a refusal. A header
// the caller got WRONG is an error rather than a silent absence — see
// idempotency.ErrInvalidKey in fail below — because a caller who meant to be
// protected must be told they were not.
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

// decode parses a request body, rejecting anything the struct does not
// declare.
//
// DisallowUnknownFields because a caller sending `{"nte": "..."}` should be
// told, not answered with a 200 that silently cleared the note. It is stricter
// than most of the estate, and the strictness is worth it on a contract
// products pin to: an unknown field today is a field this service might mean
// something by tomorrow. It is the write-side twin of
// httpx.RejectUnknownParameters, which does the same job for the reads.
func decode(body []byte, into any) error {
	if len(body) == 0 {
		return httpx.BadRequest("a request body is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		// The parse error's text is safe to return — it describes the caller's
		// own body, not this service's internals — and without it a 400 on a
		// large payload is a guessing game.
		return httpx.BadRequest("the request body is not the expected JSON: " + err.Error())
	}
	return nil
}

// The query parameters each route admits. Anything else is a 400 — see the
// package comment.
//
// Written as the union of a shared set and the route's own, so the two lists
// cannot drift on the eight parameters they share.
var (
	filterParameters = []string{
		"product", "product_unset",
		"stage",
		"owner",
		"country", "country_unset",
		"followers", "followers_unset",
		"limit", "cursor",
	}
	dueParameters      = filterParameters
	driftingParameters = append(append([]string{}, filterParameters...), "stale_days")
)

func (h *Handler) due(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, dueParameters); err != nil {
		h.fail(w, r, err)
		return
	}
	filter, limit, err := h.readQuery(query)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	payload, page, err := h.svc.Due(r.Context(), filter, limit, query.Get("cursor"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writePage(w, r, payload, page.Total, page.Preceding, page.NextCursor, page.PreviousCursor, limit, h.log)
}

func (h *Handler) drifting(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, driftingParameters); err != nil {
		h.fail(w, r, err)
		return
	}
	filter, limit, err := h.readQuery(query)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	staleDays, err := readStaleDays(query.Get("stale_days"))
	if err != nil {
		h.fail(w, r, err)
		return
	}

	payload, page, err := h.svc.Drifting(r.Context(), filter, staleDays, limit, query.Get("cursor"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writePage(w, r, payload, page.Total, page.Preceding, page.NextCursor, page.PreviousCursor, limit, h.log)
}

// writePage puts a queue page in the envelope.
//
// `total` and `preceding` are taken as VALUES and their addresses handed to
// Meta, never `&page.Total`: §3 requires them to reach the JSON as pointers so
// a genuine zero serialises and an absent count disappears, and taking the
// address of a caller's struct field would alias a value the caller can still
// see.
func writePage(w http.ResponseWriter, r *http.Request, payload service.QueuePayload,
	total int64, preceding int, next, previous string, limit int, log *slog.Logger,
) {
	httpx.WriteMeta(w, r, http.StatusOK, payload, &httpx.Meta{
		NextCursor:     next,
		PreviousCursor: previous,
		PrecedingCount: &preceding,
		Total:          &total,
		Limit:          limit,
	}, log)
}

// readQuery parses everything both queues share.
func (h *Handler) readQuery(query url.Values) (domain.Filter, int, error) {
	product, err := readMatch(query, "product")
	if err != nil {
		return domain.Filter{}, 0, err
	}
	country, err := readMatch(query, "country")
	if err != nil {
		return domain.Filter{}, 0, err
	}
	followers, err := readMatch(query, "followers")
	if err != nil {
		return domain.Filter{}, 0, err
	}

	filter := domain.Filter{
		Product: product,
		// The raw string, narrowed by Validate below rather than here. See
		// the note on that call.
		Stage:     domain.Stage(query.Get("stage")),
		Owner:     query.Get("owner"),
		Country:   country,
		Followers: followers,
	}

	// Validated BEFORE the query, so a typo'd filter is a 422 naming the
	// accepted values rather than an empty page indistinguishable from "no
	// leads match".
	//
	// The check is domain.Filter.Validate rather than a per-axis parse
	// repeated here. The domain already owns the list of stages, the list of
	// follower bands and the shape of a country code, and its messages name
	// the axis and enumerate what it would have accepted. A handler that
	// re-derived any of those would be a second copy of a vocabulary that
	// exists to be single — which is the exact failure crm-filters.ts was
	// written to prevent on the console side.
	//
	// 422 rather than 400: the request is well-formed and the service
	// understood it, and declined. The distinction is the tickets module's and
	// it is worth keeping, because only one of the two is worth a client
	// retrying differently.
	if err := filter.Validate(); err != nil {
		return domain.Filter{}, 0, filterRefusal(err)
	}

	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		return domain.Filter{}, 0, err
	}
	return filter, limit, nil
}

// filterRefusal turns a domain refusal into the wire shape §1 requires.
//
// `details` keys the offending PARAMETER to the offending VALUE — never an
// explanation, which lives in `message`, and never a key that is not something
// the caller sent, with `accepted` the one deliberate exception. This used to
// be `{"filter": "stage: unknown stage \"archived\" (want one of [new
// contacted qualified])"}`: one key that is not a parameter, one value that is
// a sentence, and a Go slice rendering inside it. A client could not read the
// axis, the value or the accepted set out of that without parsing prose.
//
// domain.FilterRefusal exists so this function has pieces to place rather than
// a string to take apart. A refusal that is somehow not one still answers 422
// with a message — losing the details is better than losing the refusal.
func filterRefusal(err error) error {
	var refusal domain.FilterRefusal
	if !errors.As(err, &refusal) {
		return httpx.Validation("the filter is not valid: "+err.Error(), nil)
	}
	details := map[string]any{refusal.Parameter: refusal.Value}
	if len(refusal.Accepted) > 0 {
		// A JSON array of the spellings a caller may send, exactly as
		// httpx.RejectUnknownParameters answers the same question for parameter
		// names. The one key in `details` that is not a parameter, and it
		// earns that because "what should I have sent" is the only part of a
		// refusal a client can act on programmatically.
		details["accepted"] = refusal.Accepted
	}
	return httpx.Validation("the filter is not valid: "+refusal.Error(), details)
}

// readMatch reads one nullable axis: `<axis>` and `<axis>_unset`.
//
// The two are mutually exclusive, and asking for both is REFUSED rather than
// resolved by precedence. "product=acme AND product is absent" is a
// contradiction, and either precedence rule would answer a question the caller
// did not ask while reporting success — the failure this whole module spends
// its validation budget on. domain.Match.validate refuses the same state one
// layer down; this is where the caller gets a message naming their own
// parameters.
func readMatch(query url.Values, axis string) (domain.Match, error) {
	value := query.Get(axis)
	unset, err := readBool(query, axis+"_unset")
	if err != nil {
		return domain.Match{}, err
	}
	if unset && value != "" {
		return domain.Match{}, httpx.Validation(
			axis+" and "+axis+"_unset cannot both be given",
			map[string]any{axis: value, axis + "_unset": "true"})
	}
	if unset {
		return domain.Unset(), nil
	}
	// Is("") is Any() by construction — an empty value is no filter. The
	// package comment states that as contract rather than leaving it as an
	// implementation detail of domain.Match.
	return domain.Is(value), nil
}

// readBool accepts exactly "true" and "false", and absence.
//
// Not strconv.ParseBool, which also accepts "1", "t", "TRUE" and "T". A narrow
// spelling is one thing for a client to get right, and — the reason that
// matters — anything ELSE is rejected rather than read as false. A caller
// sending `product_unset=yes` and meaning it would otherwise get the whole
// queue, reported as a success.
func readBool(query url.Values, name string) (bool, error) {
	switch raw := query.Get(name); raw {
	case "":
		return false, nil
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, httpx.Validation(name+" must be true or false",
			map[string]any{name: raw})
	}
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
		return 0, httpx.Validation("limit must be at least 1", map[string]any{"limit": raw})
	}
	if limit > MaxLimit {
		return MaxLimit, nil
	}
	return limit, nil
}

// readStaleDays parses the drifting queue's window.
//
// Zero is legal and means "everything open with nothing scheduled", which is a
// coherent question — the whole backlog rather than the drifting part of it.
// Negative is not: it asks for rows quiet since the future, which is empty,
// and answering "nothing is drifting" to a caller bug is the silent success
// this module refuses. The repository refuses it too; this is where the caller
// learns which parameter was wrong.
func readStaleDays(raw string) (int, error) {
	if raw == "" {
		return DefaultStaleDays, nil
	}
	days, err := strconv.Atoi(raw)
	if err != nil {
		return 0, httpx.Validation("stale_days is not a number", map[string]any{"stale_days": raw})
	}
	if days < 0 {
		return 0, httpx.Validation("stale_days cannot be negative", map[string]any{"stale_days": raw})
	}
	if days > MaxStaleDays {
		// The maximum is in the MESSAGE, not in `details`: `details` keys a
		// request parameter to the value it carried, and "max" is neither.
		return 0, httpx.Validation(
			fmt.Sprintf("stale_days is beyond what this queue measures; the most it takes is %d", MaxStaleDays),
			map[string]any{"stale_days": raw})
	}
	return days, nil
}

// fail maps an error to a response and logs what the client is not told.
//
// The mapping is why the layers below return sentinels rather than formatted
// strings. Matching on message text would be one rewording away from turning a
// 400 into a 500, and this handler's most important mapping — the malformed
// cursor — is precisely a case where the underlying error is a wrapped string.
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	var envelope httpx.Error
	switch {
	case errors.As(err, &envelope):
		// Already a decided answer — a validation failure from parsing above.

	case errors.Is(err, repository.ErrNotFound):
		envelope = httpx.NotFound("no such opportunity")

	case errors.Is(err, idempotency.ErrInvalidKey):
		envelope = httpx.BadRequest("the " + idempotency.Header + " header is not usable")

	case errors.Is(err, idempotency.ErrKeyReused):
		// 409, not a replay of the stored response. The bodies differ, so
		// replaying would silently discard the second request.
		envelope = httpx.Conflict("this " + idempotency.Header + " was already used for a different request")

	case errors.Is(err, service.ErrRefused):
		// 422: understood, and declined. Distinct from 400 — the request was
		// well-formed — and the message is the domain's own, which names what
		// it declined. The grandfathered-row refusal arrives here, and its
		// message tells the operator to supply the missing product rather than
		// naming a Postgres constraint.
		envelope = httpx.Validation(refusalMessage(err), nil)

	case errors.Is(err, paging.ErrMalformedCursor):
		// 400, not a silent first page. The cursor came off a URL, so this is
		// a bad LINK rather than a flaky read, and the two want opposite
		// advice: retrying this one can never work. It covers a bad ENCODING
		// and a bad SHAPE alike — a two-component cursor carrying
		// ["hello","world"] decodes fine and would otherwise reach a
		// ::timestamptz cast and come back as a 500.
		envelope = httpx.BadRequest("the cursor could not be read; start from the first page")

	default:
		envelope = httpx.Internal("request failed")
	}

	// Logged at every level, because the client is deliberately told less than
	// the log knows: a driver error's text must never reach a response, and an
	// operator holding the request id needs exactly that text.
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
	const prefix = "the request was refused: "
	message := err.Error()
	if strings.HasPrefix(message, prefix) {
		return strings.TrimPrefix(message, prefix)
	}
	return message
}
