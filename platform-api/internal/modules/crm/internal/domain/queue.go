// Package domain holds the CRM queues module's types and rules.
//
// Under modules/crm/internal/, so only code rooted at modules/crm/ can import
// it — the compiler enforces that, not a convention. No I/O lives here: the
// SQL is in ../repository, and everything in this file is a value, a rule or a
// parse.
package domain

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

// Stage is an opportunity's position in the funnel.
//
// The values are the `crm_stage` enum's, migration 0019. Adding one here
// without a migration produces a row the database refuses, which is the right
// way round: the schema is authoritative and this mirrors it.
//
// Stage lives on the OPPORTUNITY, never on the organisation or the contact —
// 0019's header is emphatic about it, because one business can be prospected
// for two products and lost for one without that overwriting the other.
type Stage string

const (
	StageNew       Stage = "new"
	StageContacted Stage = "contacted"
	StageQualified Stage = "qualified"
	StageWon       Stage = "won"
	StageLost      Stage = "lost"
)

var stages = []Stage{StageNew, StageContacted, StageQualified, StageWon, StageLost}

// queueStages are the stages a QUEUE FILTER may name — every stage that is not
// terminal.
//
// It is deliberately NOT `stages`. ParseStage mirrors the `crm_stage` enum and
// must keep accepting all five, because a stage read back OUT of the database
// can legitimately be won or lost. A filter is the other direction, and there
// `won` can never match: both queues exclude terminal deals by their own
// predicate, ahead of any filter.
//
// So `?stage=won` is a request that cannot succeed, and it is REFUSED rather
// than answered with an empty page. That is the same rule this module applies
// to a misspelled parameter, a sentinel band and a negative staleness window,
// and for the same reason — a silent success hides a caller bug, and an empty
// queue is indistinguishable from "nothing to do". The console never sends one
// either: crm/page.tsx:162 builds its filter bar from
// `CRM_STAGES.filter(s => s !== "won" && s !== "lost")`.
//
// Settled here rather than left as a 200, because turning it into a refusal
// LATER would break anyone who had shipped a stage dropdown including them.
var queueStages = []Stage{StageNew, StageContacted, StageQualified}

// parseQueueStage narrows a stage a caller wants to FILTER by.
//
// Its refusals enumerate `queueStages`, not `stages`. An error that offered
// `won` as an accepted value while the queue refuses it would be the service
// contradicting itself in the one place a caller is already confused.
//
// The accepted values travel in FilterRefusal.Accepted rather than inside the
// message. They used to be interpolated with %v, which renders a []Stage as
// `[new contacted qualified]` — a Go slice rendering pinned into a golden
// file, where a client parsing the accepted set out of it would break the day
// somebody changed a format verb. The module already answers the analogous
// question with a JSON array (`accepted` on an unknown query parameter), and
// this is that treatment applied to the axes too.
func parseQueueStage(raw string) (Stage, error) {
	parsed, err := ParseStage(raw)
	if err != nil {
		return "", FilterRefusal{
			Parameter: "stage",
			Value:     raw,
			Reason:    fmt.Sprintf("unknown stage %q", raw),
			Accepted:  stageNames(queueStages),
		}
	}
	if parsed.Terminal() {
		return "", FilterRefusal{
			Parameter: "stage",
			Value:     raw,
			Reason: fmt.Sprintf(
				"%q is terminal; neither queue contains a won or lost opportunity", raw),
			Accepted: stageNames(queueStages),
		}
	}
	return parsed, nil
}

// FilterRefusal is one filter axis's refusal, kept in pieces.
//
// §1's rule for `error.details` is that a key is a REQUEST PARAMETER and its
// value is the offending input; the explanation belongs in `message`, and a
// closed vocabulary belongs in `accepted` as a JSON array. A refusal formatted
// into one string cannot be taken apart again into those pieces, so the domain
// hands the handler the pieces and the handler decides the wire shape. That is
// also why Accepted is []string rather than []Stage or []FollowerBand: what
// reaches the wire is a JSON array of the spellings a caller may send, and a
// typed slice would only be rendered back to those.
//
// Accepted is nil where the axis has no closed vocabulary — a country code is
// a shape, not a list, and enumerating 249 of them would be noise.
type FilterRefusal struct {
	// Parameter is the query parameter the value arrived on, exactly as the
	// handler's grammar spells it.
	Parameter string
	// Value is what the caller sent, verbatim and unnormalised.
	Value string
	// Reason is the human half, for `message`.
	Reason string
	// Accepted is every value this axis takes, or nil if it is not a list.
	Accepted []string
}

func (r FilterRefusal) Error() string { return r.Parameter + ": " + r.Reason }

func stageNames(list []Stage) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = string(s)
	}
	return out
}

// ParseStage narrows a caller-supplied string.
//
// Returns an error rather than a bool so the caller cannot forget to check: a
// silently-ignored bad stage would filter on nothing and report a full queue
// as if it were a filtered one.
func ParseStage(raw string) (Stage, error) {
	s := Stage(raw)
	if !slices.Contains(stages, s) {
		// Joined rather than interpolated with %v: this message reaches a log
		// when a row scans back with a stage this module does not know, and a
		// Go slice rendering there is the same readability problem it was on
		// the wire, minus the contract.
		return "", fmt.Errorf("unknown stage %q (want one of %s)", raw, strings.Join(stageNames(stages), ", "))
	}
	return s, nil
}

// Terminal reports whether a deal is finished. Both queues exclude terminal
// opportunities: a work queue listing things already won or lost is a to-do
// list of things already done.
func (s Stage) Terminal() bool { return s == StageWon || s == StageLost }

// FollowerBand is a follower-count range for the queues' `followers` filter.
//
// The identifiers are byte-for-byte `FOLLOWER_BANDS`' keys in
// apps/console/lib/db/crm-filters.ts, and so are the bounds. That is
// deliberate and it is the whole of the console's translation problem: the
// filter bar renders options from that object, so a band whose name or edge
// differed here would be a filter the operator can select and this service
// rejects, or worse, one that quietly answers a different question.
//
// Bounds are INCLUSIVE integers, not half-open ranges, and MaxUnbounded says
// "no upper bound" rather than encoding infinity as a number.
type FollowerBand string

const (
	FollowersUnder1k FollowerBand = "under1k"
	Followers1kTo10k FollowerBand = "k1to10k"
	FollowersOver10k FollowerBand = "over10k"
)

// MaxUnbounded is FollowerBounds.Max on the top band.
const MaxUnbounded = -1

// FollowerBounds is one band's inclusive range.
type FollowerBounds struct {
	Min int
	// Max is MaxUnbounded when the band has no upper edge.
	Max int
}

var followerBands = map[FollowerBand]FollowerBounds{
	FollowersUnder1k: {Min: 0, Max: 999},
	Followers1kTo10k: {Min: 1000, Max: 9999},
	FollowersOver10k: {Min: 10000, Max: MaxUnbounded},
}

// Bounds returns a band's range. The second result is false for a value that
// is not a band, which is what keeps the repository from building a predicate
// out of a zero value.
func (b FollowerBand) Bounds() (FollowerBounds, bool) {
	bounds, ok := followerBands[b]
	return bounds, ok
}

// ParseFollowerBand narrows a caller-supplied string.
//
// Note what it does NOT accept: the console's `UNKNOWN_FOLLOWERS` sentinel.
// Absence is Unset() on the filter axis, not a fourth band — see Match.
func ParseFollowerBand(raw string) (FollowerBand, error) {
	b := FollowerBand(raw)
	if _, ok := followerBands[b]; !ok {
		return "", FilterRefusal{
			Parameter: "followers",
			Value:     raw,
			Reason:    fmt.Sprintf("unknown follower band %q", raw),
			Accepted:  bandNames(),
		}
	}
	return b, nil
}

// bandNames is sorted, because it reaches the wire: Go randomises map
// iteration, and an `accepted` array that reordered between two identical
// requests would show up as a spurious diff in a golden file and as noise to a
// client comparing responses.
func bandNames() []string {
	names := make([]string, 0, len(followerBands))
	for name := range followerBands {
		names = append(names, string(name))
	}
	slices.Sort(names)
	return names
}

// Match is one filter axis's value on a column that can be NULL: no filter at
// all, a specific value, or explicitly "the value is absent".
//
// # Why this exists rather than the console's sentinel strings
//
// crm-filters.ts spells absence as a magic value INSIDE the axis:
// `UNASSIGNED_PRODUCT` is "__unassigned__", `UNKNOWN_COUNTRY` and
// `UNKNOWN_FOLLOWERS` are "__unknown__". That is right where it lives — the
// filter bar is a Radix `Select`, which cannot hold an empty-string item
// value, so the option needs SOME string, and the module comment there
// explains why the literal is shared with the repo rather than duplicated.
//
// It is wrong on a wire contract, and §2 is the reason: resources are
// domain-shaped and the console composes. "__unassigned__" is the filter bar's
// vocabulary — a workaround for a UI component's constraint — and a product
// calling `GET /v1/crm/queues/due` has no filter bar, no Radix and no reason
// to know the string. Worse, it is unsound as a *value*: the axis it sits on
// is a text column, so "__unassigned__" is a product name a row could
// legitimately carry, and a sentinel that collides with real data has no
// spelling that fixes it. A separate state cannot collide.
//
// So absence is a state of the axis, and the wire grammar Task 4 derives from
// it is a sibling flag — `product=x` or `product_unset=true`, uniformly across
// all three nullable axes.
//
// # The counter-argument, so the next reader has it
//
// crm-filters.ts exists PRECISELY because a duplicated literal that drifts by
// one character fails silently: the filter would simply match nothing. Trading
// one shared literal for a translation across a language boundary reintroduces
// exactly that risk if the translation is scattered. It must not be. The
// console side gets ONE function that turns a `QueueFilter` into query
// parameters — sentinel in, `_unset=true` out — living beside
// crm-filters.ts, so the rule is stated once there just as the literal is
// today. The band NAMES are deliberately identical for the same reason: only
// absence needs translating, and only in that one function.
type Match struct {
	value string
	unset bool
}

// Any is no filter on this axis: every row qualifies.
func Any() Match { return Match{} }

// Is filters to rows carrying exactly `value`.
//
// Is("") is indistinguishable from Any() by construction — an empty filter and
// no filter are the same struct — which is the right collapse: "filter product
// to the empty string" is not a question this schema can answer, since the
// column is either NULL or a real name. Callers that mean "no value" say
// Unset().
func Is(value string) Match { return Match{value: value} }

// Unset filters to rows where the axis has no value — a NULL column, or (for
// followers) a primary contact with no recorded count.
func Unset() Match { return Match{unset: true} }

// IsAny reports that this axis adds no predicate.
func (m Match) IsAny() bool { return !m.unset && m.value == "" }

// IsUnset reports that this axis selects rows with no value.
func (m Match) IsUnset() bool { return m.unset }

// Value is the value to match, meaningful only when neither IsAny nor IsUnset.
func (m Match) Value() string { return m.value }

// validate rejects the one incoherent state: an axis that is both unset and a
// value. The three constructors cannot produce it, but a struct literal inside
// this package could, and "unset AND equals x" is a contradiction whose SQL
// would silently pick one half. `axis` names the field so the message points
// at the caller's parameter rather than at this type.
func (m Match) validate(axis string) error {
	if m.unset && m.value != "" {
		return FilterRefusal{
			Parameter: axis,
			Value:     m.value,
			Reason:    fmt.Sprintf("cannot be both unset and %q", m.value),
		}
	}
	return nil
}

// Filter narrows a queue on the five axes the console's QueueFilter carries.
//
// Applied in SQL, ahead of ORDER BY and LIMIT. Filtering a fetched page in Go
// would answer "rows matching the filter among the first N overall", silently
// dropping a match ranked below the cut-off — which in a work queue presents
// as "nothing to do" rather than as an error. crm-repo.ts's own comment on
// QueueFilter (Ruling 11) is the record of that.
//
// Stage and Owner are plain fields rather than Matches because their columns
// carry no meaningful absence for a filter to select: `stage` is NOT NULL, and
// while `owner` is nullable the console offers no "unassigned owner" option.
// Adding one is a wire change, and it should be made deliberately rather than
// pre-built here.
type Filter struct {
	// Product matches `crm_opportunities.product` exactly; Unset selects the
	// rows with no product assigned. Every import and every migrated lead
	// lands with a null product, so Unset is the busiest option on this axis,
	// not an edge case.
	Product Match
	// Stage matches `crm_opportunities.stage` exactly, and may name only a
	// NON-TERMINAL stage — `won` and `lost` are refused rather than answered
	// with an empty page. Zero value: no filter.
	Stage Stage
	// Owner is a case-insensitive SUBSTRING match on `crm_opportunities.owner`,
	// matching the console. Zero value: no filter.
	Owner string
	// Country matches the DERIVED `crm_organisations.country` column exactly —
	// never a pattern over the raw `location`. Unset selects the rows where it
	// is NULL, which migration 0025 records as 208 of 259 organisations, so an
	// operator without this option reaches under a fifth of the CRM.
	Country Match
	// Followers is the follower-count band of the organisation's PRIMARY
	// contact — the same contact the row displays. Unset selects the rows with
	// no such count to show. Value must parse as a FollowerBand.
	Followers Match
}

// Validate checks every axis BEFORE any query runs.
//
// Called by the repository rather than trusted to the handler, so an unchecked
// value cannot reach the SQL by way of a second caller. A bad filter costs no
// round trip, and — the reason that matters here — the count query and the row
// query would otherwise be able to disagree about whether the filter was
// legal at all.
func (f Filter) Validate() error {
	if err := f.Product.validate("product"); err != nil {
		return err
	}
	if err := f.Country.validate("country"); err != nil {
		return err
	}
	if err := f.Followers.validate("followers"); err != nil {
		return err
	}
	if f.Stage != "" {
		// parseQueueStage, not ParseStage: a queue filter may not name a
		// terminal stage. See the comment on queueStages.
		//
		// Returned unwrapped, here and below: a FilterRefusal already carries
		// the parameter it belongs to, and wrapping it with the axis name
		// again would put "stage: " in front of a message that a handler is
		// about to print beside `"stage": "won"` anyway.
		if _, err := parseQueueStage(string(f.Stage)); err != nil {
			return err
		}
	}
	if !f.Country.IsAny() && !f.Country.IsUnset() {
		if err := validCountry(f.Country.Value()); err != nil {
			return err
		}
	}
	if !f.Followers.IsAny() && !f.Followers.IsUnset() {
		if _, err := ParseFollowerBand(f.Followers.Value()); err != nil {
			return err
		}
	}
	return nil
}

// validCountry checks the shape `crm_organisations.country` actually holds:
// ISO 3166-1 alpha-2, upper case, as @tesserix/crm-country returns it.
//
// Checked rather than normalised. Upper-casing a caller's "in" would answer a
// question they did not quite ask, and the failure this prevents — a filter
// that matches nothing and says nothing — is exactly the one silent-success
// case worth turning into a 400.
func validCountry(code string) error {
	if len(code) != 2 || code[0] < 'A' || code[0] > 'Z' || code[1] < 'A' || code[1] > 'Z' {
		return FilterRefusal{
			Parameter: "country",
			Value:     code,
			Reason:    fmt.Sprintf("%q is not an upper-case ISO 3166-1 alpha-2 code", code),
			// No Accepted: this axis is a SHAPE, not a vocabulary. Listing
			// every alpha-2 code would be 249 strings on every refusal, and
			// the ones this table actually holds are data rather than
			// contract.
		}
	}
	return nil
}

// Opportunity is one row of a queue: the deal, with the organisation's name
// resolved so a caller need not join for the one field it always renders.
//
// The nullable columns are pointers rather than zero values. `product` absent
// and `product` empty are different facts here — the first is an unattributed
// lead, which is most of the table — and a type that flattened them would make
// the Unset filter above unrepresentable in its own results.
type Opportunity struct {
	ID               string
	OrganisationID   string
	OrganisationName string
	Product          *string
	Stage            Stage
	Owner            *string
	NextActionAt     *time.Time
	NextActionNote   *string
	LastContactedAt  *time.Time

	// QuietSince is COALESCE(last_contacted_at, created_at) — what the
	// drifting queue orders and measures staleness by.
	//
	// Named for what it means rather than exposing raw created_at, and carried
	// on DUE rows too so the shape is uniform across the queue. A caller that
	// recomputed the COALESCE itself would be a second copy of a rule that
	// decides row order, and the two copies would disagree the first time one
	// of them changed. NOT NULL: created_at is.
	QuietSince time.Time
	IsStarred  bool
}
