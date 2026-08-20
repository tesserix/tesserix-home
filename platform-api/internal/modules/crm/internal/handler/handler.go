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
// # These routes take no request body
//
// Both are reads, so there is no JSON to decode strictly. The equivalent
// strictness for a read is `rejectUnknownParameters`: a caller sending
// `?stge=new` is told, rather than answered with an unfiltered queue reported
// as a success. That is the same failure DisallowUnknownFields exists to
// prevent, in the place a read can make it.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
)

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
// # Nothing is inherited
//
// Each route names what it needs. Both of these are reads, so both name `crm`
// and no verb — a queue is genuinely readable by anyone who works the CRM
// surface. The writes Task 5 adds will stack their verb ON TOP of `crm`
// rather than replacing it, the way the tickets module stacks `respond` on
// `support`.
//
// Named Routes rather than Register: this module's public Register/Config file
// is Task 6's, and it will call this.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	read := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log, auth.RequireCapability(auth.CapCRM, h.log, handler))
	}

	mux.Handle("GET /v1/crm/queues/due", read(h.due))
	mux.Handle("GET /v1/crm/queues/drifting", read(h.drifting))
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
	if err := rejectUnknownParameters(query, dueParameters); err != nil {
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
	if err := rejectUnknownParameters(query, driftingParameters); err != nil {
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
		return domain.Filter{}, 0, httpx.Validation("the filter is not valid",
			map[string]any{"filter": err.Error()})
	}

	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		return domain.Filter{}, 0, err
	}
	return filter, limit, nil
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
		return 0, httpx.Validation("stale_days is beyond what this queue measures",
			map[string]any{"stale_days": raw, "max": MaxStaleDays})
	}
	return days, nil
}

// rejectUnknownParameters refuses a query carrying anything this route does
// not read.
//
// # Why this is worth a 400
//
// It is the read-side equivalent of DisallowUnknownFields, and the argument is
// the same one §2 makes for a strict decode: a caller sending `?stge=new`
// otherwise receives the WHOLE queue and a 200. A filter that silently does
// nothing is the broader-result-set failure that runs through this entire
// module — the same one crm-filters.ts exists to prevent, and the same one
// domain.Filter.Validate refuses a bad value for. Accepting a misspelled
// parameter would leave the one hole all of that was closing.
//
// The accepted list is returned in the message, sorted, because the person
// reading it is looking at a URL that does not work and needs to know what to
// write instead.
func rejectUnknownParameters(query url.Values, allowed []string) error {
	known := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		known[name] = struct{}{}
	}
	var unknown []string
	for name := range query {
		if _, ok := known[name]; !ok {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	// Sorted so the message is the same on every run: Go randomises map
	// iteration, and a test asserting on this would otherwise flake.
	sort.Strings(unknown)
	accepted := append([]string{}, allowed...)
	sort.Strings(accepted)
	return httpx.BadRequest("the request carries query parameters this endpoint does not read").
		WithDetails(map[string]any{"unknown": unknown, "accepted": accepted})
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
