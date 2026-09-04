// Package repository holds the CRM queues module's SQL.
//
// Under modules/crm/internal/, so only code rooted at modules/crm/ can import
// it — the compiler enforces that, not a convention.
//
// # Two queues, one pager
//
// `Due` and `Drifting` are the Go rewrite of dueOpportunities and
// driftingOpportunities in apps/console/lib/db/crm-repo.ts. They differ in
// exactly four things — their own predicate, the expression they sort by, the
// fact that Drifting takes a staleness window, and their NAME, which their
// cursors carry so that one queue's cursor is refused by the other (see
// queue.shape) — so everything else lives in `queuePage`, the way `queuePage`
// does on the console side. Two copies of a
// keyset pager is two chances for one of them to skip a row at a page
// boundary, and a skipped row in a work queue is invisible.
//
// # No ORM, and no query builder
//
// The kernel's database package records the general reason. The specific one
// here is the follower filter: a correlated subquery selecting an
// organisation's PRIMARY contact and then testing that contact's count. It is
// a query to write once and read carefully, not one to assemble.
package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
)

// Querier is the subset of pgx the reads need. Satisfied by both a pool and a
// transaction, so a read can join a write's transaction when it must — a stage
// transition that re-reads its queue inside the same transaction cannot then
// describe a state that was rolled back.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// queueColumns is what every queue row is built from — one list, so Due and
// Drifting cannot drift apart on what an Opportunity is.
//
// The two uuid columns are cast to text because every consumer of this API
// treats an id as an opaque string. Casting in SQL rather than in Go keeps the
// driver from choosing a representation.
const queueColumns = `o.id::text, o.organisation_id::text, g.name,
	o.product, o.stage, o.owner,
	o.next_action_at, o.next_action_note, o.last_contacted_at,
	COALESCE(o.last_contacted_at, o.created_at), o.is_starred`

// The two queues' sort expressions.
//
// Named constants because each one appears in the ORDER BY, in the keyset
// predicate and in the preceding-count FILTER, and all three must be the same
// expression. Three copies of a COALESCE is three chances to change two of
// them — crm-repo.ts's DRIFTING_SORT_KEY exists for the same reason.
const (
	dueSortKey      = `o.next_action_at`
	driftingSortKey = `COALESCE(o.last_contacted_at, o.created_at)`
)

// Both queues sort ASCENDING on their timestamp, then on `o.id`.
//
// # Why the tiebreak is load-bearing
//
// Rows sharing a sort timestamp otherwise come back in whatever order the plan
// produces — harmless for one capped page, fatal for a keyset walk, because a
// row can repeat on one page and never appear on another. Migration 0021 wrote
// 259 rows in one batch, so ties are the normal case on this data rather than
// an edge one.
//
// # Why no component is negated here, unlike the ticket queue
//
// A row-value comparison compares the whole tuple in ONE direction, so the
// ticket queue negates its two ascending integer components to make its mixed
// sort uniform. These two queues are already uniformly ascending — soonest
// due first, longest quiet first — so the tuple comparison is the plain one
// and there is nothing to negate.
const (
	forwardOrder  = "ASC"
	backwardOrder = "DESC"
)

// The two queues' names. They are the last path segment of each route, they
// are the third component of every cursor either queue mints, and they are the
// reason a cursor from one is not usable on the other. See queueNamed.
const (
	dueName      = "due"
	driftingName = "drifting"
)

// shape is this queue's cursor key, component by component: the queue's
// timestamp, then id, then the queue's own NAME.
//
// paging.Decode checks the COUNT — so a cursor minted by the ticket queue,
// which sorts on four, is rejected rather than bound positionally against
// columns that mean something else — and the CONTENT, so a well-formed cursor
// carrying ["hello","world"] is a 400 rather than an `invalid input syntax for
// type timestamp with time zone` arriving from `$1::timestamptz` as a 500.
//
// # Why the count check is NOT enough, which is what this file used to claim
//
// Both queues sorted on two components of the same types, and both used ONE
// package-level shape. So a DRIFTING cursor — anchored on
// COALESCE(last_contacted_at, created_at) — pasted onto /v1/crm/queues/due
// decoded cleanly and bound against o.next_action_at, and the page came back
// 200 with `total` and `preceding_count` computed consistently against an
// anchor that means something else entirely. Nothing looked wrong. That is
// exactly the failure §3 says the version and the length check exist to
// prevent: "a page rendered from the wrong anchor, reported as a success".
// The old comment here cited the ticket queue as proof the guarantee held —
// true only because tickets happens to sort on four components.
//
// It is not theoretical. The console guards the same collision with two
// SEPARATE query parameters (DUE_CURSOR_PARAM and DRIFT_CURSOR_PARAM in
// apps/console/app/(console)/platform/crm/page.tsx), and buildQueueCursorHref
// deliberately preserves the other queue's cursor while replacing its own.
// This API exposes ONE `cursor` parameter on both routes, so that mitigation
// did not survive the port and has to be rebuilt inside the cursor.
//
// # Why a third component rather than two shapes
//
// Two shapes of the same length and the same component types would be the same
// check twice: the distinctness has to be in the cursor's CONTENT, because
// there is nothing else about a due cursor that differs from a drifting one.
// So the queue names itself in its own key, and queueNamed refuses any other
// name. A component is also the only place the refusal composes with
// everything else — it unwraps to paging.ErrMalformedCursor, so the handler
// already answers 400 ("start from the first page"), which is the right advice
// for a link that cannot work here whatever it does elsewhere.
func (q queue) shape() paging.Shape {
	return paging.Shape{paging.Timestamp, paging.UUID, queueNamed(q.name)}
}

// queueNamed accepts one queue's own name and nothing else.
//
// The component ANCHORS nothing — appendAnchor binds the first two components
// and never this one — so it costs no parameter and no comparison. It is
// identity, carried inside the opaque string so that it travels with the
// cursor into a bookmark or a link the way the direction and the version do.
func queueNamed(name string) paging.Component {
	return func(value string) error {
		if value != name {
			return fmt.Errorf("%q minted this cursor; the %s queue cannot page from it", value, name)
		}
		return nil
	}
}

// Page is one page of a queue plus the counts a caller needs to describe it
// honestly.
//
// The counts and the cursors are the kernel's own types, embedded rather than
// redeclared, so the fields a caller reads cannot drift from what
// paging.Resolve produced. Only the rows are named for the domain, which is
// what §2 asks of a resource: `page.Opportunities` at a call site, not
// `page.Rows`.
type Page struct {
	Opportunities []domain.Opportunity
	paging.Counts
	paging.Cursors
}

// Due reads one page of the opportunities whose next action has arrived.
//
// Terminal deals are excluded — surfacing them would make the queue a to-do
// list of things already finished. Most-overdue-first.
//
// The queue's own predicates are written FIRST and the filters spliced after,
// which is how crm_opp_due_idx stays eligible. Eligible is not chosen: a
// selective country or follower filter can legitimately lead the planner to
// drive from crm_organisations instead. Which index runs is Postgres's call.
func Due(ctx context.Context, db Querier, filter domain.Filter, limit int, rawCursor string) (Page, error) {
	return queuePage(ctx, db, queue{
		name:    dueName,
		sortKey: dueSortKey,
		predicate: func(*[]any) string {
			return `o.next_action_at <= now() AND o.stage NOT IN ('won', 'lost')`
		},
		// Non-null on every returned row: the predicate above requires it.
		sortValue: func(o domain.Opportunity) time.Time { return *o.NextActionAt },
	}, filter, limit, rawCursor)
}

// Drifting reads one page of the opportunities that have gone quiet with
// nothing scheduled.
//
// Drifting requires BOTH conditions, not either. An OR here would surface
// every scheduled lead as drifting the moment it went quiet, which is the
// opposite of the point.
//
// A NULL last_contacted_at means "never contacted", not "contacted at the dawn
// of time", so staleness — and the order — is measured from
// COALESCE(last_contacted_at, created_at). Without that, every freshly
// imported lead would be instantly drifting, flooding the queue the moment an
// import finishes. A never-contacted lead gets the same grace period as a
// contacted one, counted from when it entered the system.
//
// `staleDays` is bound as a parameter and turned into an interval by
// make_interval, never interpolated: an interval literal built by string
// concatenation is a query that changes shape with its input.
func Drifting(ctx context.Context, db Querier, filter domain.Filter, staleDays, limit int, rawCursor string) (Page, error) {
	if staleDays < 0 {
		// Before any query, like the filter check. A negative window asks for
		// rows quiet since the future, which is empty — and answering "no
		// drifting leads" to a caller bug is the silent success this package
		// spends its validation on avoiding.
		return Page{}, fmt.Errorf("staleDays is %d; a staleness window cannot be negative", staleDays)
	}
	return queuePage(ctx, db, queue{
		name:    driftingName,
		sortKey: driftingSortKey,
		predicate: func(args *[]any) string {
			*args = append(*args, staleDays)
			return fmt.Sprintf(
				`o.next_action_at IS NULL AND o.stage NOT IN ('won', 'lost')
				 AND %s <= now() - make_interval(days => $%d::int)`,
				driftingSortKey, len(*args))
		},
		sortValue: func(o domain.Opportunity) time.Time { return o.QuietSince },
	}, filter, limit, rawCursor)
}

// queue is what distinguishes one queue from the other.
type queue struct {
	// name identifies this queue in its own cursors, so a cursor minted by the
	// other one is refused rather than bound against the wrong anchor. See
	// queue.shape.
	name string
	// sortKey is the SQL expression this queue orders by. A package constant,
	// never caller input — it is spliced into the statement, not bound.
	sortKey string
	// predicate builds this queue's own WHERE body, appending any bound
	// parameters it needs. Called once per statement, because the count query
	// and the row query bind separate parameter lists.
	predicate func(args *[]any) string
	// sortValue is the sort key's value on a returned row, for the cursor.
	sortValue func(domain.Opportunity) time.Time
}

// queuePage runs one queue's count and row queries and assembles a Page.
//
// # The two queries run SEQUENTIALLY
//
// The console runs its equivalent pair with Promise.all; this service does
// not. paging.Counts carries the reasoning, since it owns the pair: the pool
// is capped at two connections (ADR-003 D2a), so a concurrent pair would take
// both for one request and turn the second concurrent listing into a wait for
// a connection rather than a wait for a query.
//
// # One predicate builder, two parameter lists
//
// `where` is called once for the count and once for the rows. It is the SAME
// function both times, so "matching the filter" cannot come to mean two
// things — which is the failure that would make `total` describe a different
// set from the rows it is printed beside. The parameter lists differ only
// because the row query appends a keyset comparison and a limit that the count
// query has no use for.
func queuePage(ctx context.Context, db Querier, q queue, filter domain.Filter, limit int, rawCursor string) (Page, error) {
	// Validated before either query runs, so a bad filter costs no round trip
	// and cannot reach the SQL through a second caller.
	if err := filter.Validate(); err != nil {
		return Page{}, err
	}
	var cursor *paging.Cursor
	if rawCursor != "" {
		decoded, err := paging.Decode(rawCursor, q.shape())
		if err != nil {
			return Page{}, err
		}
		cursor = &decoded
	}
	backwards := cursor != nil && cursor.Direction == paging.Before

	// Rows ahead of this page, in the queue's own ascending order. Aggregated
	// into the count query rather than asked for separately: it is the same
	// predicate over the same rows, differing only by a FILTER clause, so a
	// third query would re-scan what the second already had in hand.
	//
	// Forward, the cursor IS the last row of the previous page and the page
	// predicate below excludes it, so it counts as preceding (<=). Backward,
	// the cursor is the first row of the page being LEFT: it sorts after this
	// page, so it must not be counted (<), and the count then covers this page
	// plus everything ahead of it. paging.Resolve subtracts the page's own
	// length; nothing here pre-adjusts it.
	countArgs := make([]any, 0, 8)
	countWhere, err := where(q, filter, &countArgs)
	if err != nil {
		return Page{}, err
	}
	precedingSelect := "0"
	if cursor != nil {
		comparison := "<="
		if backwards {
			comparison = "<"
		}
		anchor := appendAnchor(cursor, &countArgs)
		precedingSelect = fmt.Sprintf(`count(*) FILTER (WHERE (%s, o.id) %s %s)`,
			q.sortKey, comparison, anchor)
	}

	var total int64
	var preceding int
	countSQL := fmt.Sprintf(
		`SELECT count(*), %s
		   FROM crm_opportunities o
		   JOIN crm_organisations g ON g.id = o.organisation_id
		  WHERE %s`, precedingSelect, countWhere)
	if err := db.QueryRow(ctx, countSQL, countArgs...).Scan(&total, &preceding); err != nil {
		return Page{}, fmt.Errorf("counting the queue: %w", err)
	}

	pageArgs := make([]any, 0, 8)
	pageWhere, err := where(q, filter, &pageArgs)
	if err != nil {
		return Page{}, err
	}
	if cursor != nil {
		comparison := ">"
		if backwards {
			comparison = "<"
		}
		anchor := appendAnchor(cursor, &pageArgs)
		pageWhere += fmt.Sprintf("\n            AND (%s, o.id) %s %s", q.sortKey, comparison, anchor)
	}
	order := forwardOrder
	if backwards {
		// Flipped with the comparison. Without this the LIMIT would keep the
		// rows FURTHEST from the anchor — the top of the whole queue, not the
		// page immediately before this cursor.
		order = backwardOrder
	}
	// limit + 1: the extra row is self-contained proof another page exists.
	// Comparing against the total instead would be wrong under a concurrent
	// insert, and would still need this query to read one row further.
	pageArgs = append(pageArgs, limit+1)

	pageSQL := fmt.Sprintf(
		`SELECT %s
		   FROM crm_opportunities o
		   JOIN crm_organisations g ON g.id = o.organisation_id
		  WHERE %s
		  ORDER BY %s %s, o.id %s
		  LIMIT $%d`,
		queueColumns, pageWhere, q.sortKey, order, order, len(pageArgs))

	rows, err := db.Query(ctx, pageSQL, pageArgs...)
	if err != nil {
		return Page{}, fmt.Errorf("listing the queue: %w", err)
	}
	fetched, err := scanOpportunities(rows)
	if err != nil {
		return Page{}, err
	}

	// The trimming, the backward adjustment of Preceding, and both cursors are
	// the kernel's: paging.Resolve owns the forward/backward asymmetry so this
	// module does not re-derive it. This module supplies only what the kernel
	// cannot know — the counts its own SQL produced, and the key its own ORDER
	// BY sorts on.
	resolved, err := paging.Resolve(fetched, limit, cursor,
		&paging.Counts{Total: total, Preceding: preceding}, cursorKey(q))
	if err != nil {
		return Page{}, err
	}
	// Non-nil because counts were passed above; both queues always report
	// them.
	return Page{
		Opportunities: resolved.Rows,
		Counts:        *resolved.Counts,
		Cursors:       resolved.Cursors,
	}, nil
}

// appendAnchor pushes a cursor's two components and returns the parenthesised
// placeholder pair that references them.
//
// The casts are written out rather than left to inference because one side of
// the comparison is an EXPRESSION — the drifting queue's COALESCE — not a bare
// column, and stating the type is cheaper than depending on what the planner
// deduces there. The ticket queue lost an afternoon to exactly this class of
// problem in the opposite direction.
// Only the first two components are bound: the third names the queue that
// minted the cursor and is checked by q.shape(), not compared against a column.
func appendAnchor(cursor *paging.Cursor, args *[]any) string {
	*args = append(*args, cursor.Key[0], cursor.Key[1])
	return fmt.Sprintf("($%d::timestamptz, $%d::uuid)", len(*args)-1, len(*args))
}

// cursorKey renders the anchor for one row: this listing's two ORDER BY
// components, in declaration order, then the queue's own name.
//
// RFC3339Nano in UTC, because the value is compared back against a
// timestamptz and a truncated rendering would put the anchor a fraction of a
// second off the row it names — which shows up as a page boundary that repeats
// or skips a row, and nowhere else.
//
// The name is not part of the ORDER BY and is never bound into the query. It
// is here so that q.shape() has something to check, which is what makes a
// drifting cursor unusable on the due queue and the other way round.
func cursorKey(q queue) paging.Key[domain.Opportunity] {
	return func(o domain.Opportunity) []string {
		return []string{q.sortValue(o).UTC().Format(time.RFC3339Nano), o.ID, q.name}
	}
}

// where builds the whole WHERE body: the queue's own predicate first, the
// filters spliced after.
//
// The order is not cosmetic. The queue's predicates are the ones the partial
// indexes (crm_opp_due_idx, crm_opp_drifting_idx) are defined on, and writing
// them first keeps the statement readable as "this queue, narrowed" rather
// than as an undifferentiated conjunction.
func where(q queue, filter domain.Filter, args *[]any) (string, error) {
	clauses := []string{q.predicate(args)}
	filters, err := filterClauses(filter, args)
	if err != nil {
		return "", err
	}
	clauses = append(clauses, filters...)
	return strings.Join(clauses, "\n            AND "), nil
}

// filterClauses builds the five-axis filter, appending every value as a bound
// parameter and never interpolating one.
//
// An absent axis adds no clause at all, so the queue's own predicates stay
// first and unmodified whatever filters are active.
func filterClauses(filter domain.Filter, args *[]any) ([]string, error) {
	var clauses []string
	bind := func(value any) int {
		*args = append(*args, value)
		return len(*args)
	}

	switch {
	case filter.Product.IsUnset():
		// No bound parameter: this is a NULL test, not a comparison. `= NULL`
		// is never true in SQL, which is the bug this branch exists to avoid.
		clauses = append(clauses, "o.product IS NULL")
	case !filter.Product.IsAny():
		clauses = append(clauses, fmt.Sprintf("o.product = $%d", bind(filter.Product.Value())))
	}

	if filter.Stage != "" {
		// Cast: `stage` is the crm_stage ENUM, and a text parameter compared
		// against it without one leaves Postgres to resolve an operator it
		// will refuse in some parameter orders.
		clauses = append(clauses, fmt.Sprintf("o.stage = $%d::crm_stage", bind(string(filter.Stage))))
	}

	if filter.Owner != "" {
		// A bound parameter, so this is not injectable — but an unescaped
		// value still lets `%` and `_` act as LIKE wildcards instead of
		// literal characters (an owner filter of exactly "%" would match every
		// row with a non-null owner). Backslash is escaped FIRST, so it does
		// not double-escape the characters it is about to introduce.
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(filter.Owner)
		clauses = append(clauses, fmt.Sprintf(`o.owner ILIKE $%d ESCAPE '\'`, bind("%"+escaped+"%")))
	}

	switch {
	case filter.Country.IsUnset():
		// A NULL test, same shape and same reason as the unset-product branch.
		clauses = append(clauses, "g.country IS NULL")
	case !filter.Country.IsAny():
		// Exact match on the DERIVED column, never a pattern over the raw
		// `location`. Migration 0025 is explicit that `location` mixes
		// granularities — a country, a city, a state, both — so filtering it
		// directly gives a long tail of near-duplicates that only grows.
		clauses = append(clauses, fmt.Sprintf("g.country = $%d", bind(filter.Country.Value())))
	}

	clause, err := followerClause(filter.Followers, args)
	if err != nil {
		return nil, err
	}
	if clause != "" {
		clauses = append(clauses, clause)
	}
	return clauses, nil
}

// primaryContactOrder is the one ordering that decides which contact is "the
// primary": the flagged contact, then the oldest, then by id.
//
// `id` last is load-bearing. `crm_contacts.created_at` is not unique — an
// import writes a batch of contacts in one transaction, sharing it exactly —
// so without a total order each subquery breaks a tie independently, and the
// filter would match on one contact while the row on screen showed another.
// The console records this as a defect it has already had twice.
const primaryContactOrder = `c2.is_primary DESC, c2.created_at ASC, c2.id ASC`

// followerClause is the filter axis that is NOT a column predicate.
//
// It is a correlated subquery: find the organisation's PRIMARY contact — the
// same one the row displays — and test THAT contact's follower count. The
// obvious alternative, `EXISTS (… WHERE c.followers_count BETWEEN …)`, would
// match an organisation whose SECONDARY contact happens to fall in the band,
// putting a row in a bucket that disagrees with the number printed on it.
//
// A NULL followers_count is excluded EXPLICITLY (`IS NOT NULL`) rather than
// left to fail the upper bound implicitly. `NULL <= 999` is NULL, not true, so
// the exclusion holds either way — but leaving it implicit would make that
// reliance invisible to the next reader, and the top band has no upper bound
// to rely on at all.
func followerClause(followers domain.Match, args *[]any) (string, error) {
	if followers.IsAny() {
		return "", nil
	}
	if followers.IsUnset() {
		// The complement of every band: this organisation has no primary
		// contact carrying a follower count.
		//
		// Scoped to the primary contact the same way the bands are, so an
		// organisation whose SECONDARY contact has 50k followers is still
		// "unset" — the bands describe the contact the row displays, and an
		// option that disagreed with them about which contact it means would
		// put the same organisation in two answers, or in neither.
		//
		// An organisation with NO contacts at all satisfies this vacuously,
		// which is deliberate: it has no follower count to show either, and
		// excluding it would leave it reachable from no follower option at
		// all — the very defect this option exists to fix. Bands ∪ unset
		// therefore covers every row.
		return primaryContactExists("NOT EXISTS", ""), nil
	}
	// Validated by domain.Filter.Validate before any query ran, so the band is
	// known here. Checked anyway rather than dereferenced blind — and the
	// check FAILS CLOSED. Returning "" would drop the filter and answer an
	// UNFILTERED queue, reported as a success, which is the broader-result-set
	// failure the whole validation budget of this package is spent avoiding.
	// A future second caller that skips Validate gets an error, not more rows
	// than it asked for.
	bounds, ok := domain.FollowerBand(followers.Value()).Bounds()
	if !ok {
		return "", fmt.Errorf("followers: %q is not a follower band", followers.Value())
	}
	*args = append(*args, bounds.Min)
	test := fmt.Sprintf("\n               AND c.followers_count >= $%d", len(*args))
	if bounds.Max != domain.MaxUnbounded {
		*args = append(*args, bounds.Max)
		test += fmt.Sprintf("\n               AND c.followers_count <= $%d", len(*args))
	}
	return primaryContactExists("EXISTS", test), nil
}

// primaryContactExists writes the correlated subquery both follower branches
// share, so the "which contact is the primary" half cannot differ between
// them. `existence` is EXISTS or NOT EXISTS; `test` is the extra predicate on
// the chosen contact, empty for the unset branch.
//
// `c2.erased_at IS NULL` keeps an ERASED contact out of that selection (#301).
// Erasure redacts a contact in place — the row survives, so the organisation
// keeps its history — but `is_primary` survives the redaction too, so without
// this predicate the erased row stays the contact every follower band resolves
// to. An organisation whose primary contact exercised erasure was filtered on
// a person who asked to be forgotten, and — where a LIVE second contact
// existed — on the wrong person entirely: the live contact's follower count
// was invisible while the erased row held the primary slot.
//
// An organisation whose ONLY contact is erased therefore has no primary
// contact and lands in the unset band, which already exists to hold exactly
// that shape of row. The console's `notErased` in `crm-repo.ts` carries the
// same predicate: both implementations are live against the same schema and
// must not disagree on a compliance-adjacent surface.
func primaryContactExists(existence, test string) string {
	return fmt.Sprintf(`%s (
            SELECT 1 FROM crm_contacts c
             WHERE c.organisation_id = g.id
               AND c.id = (
                 SELECT c2.id FROM crm_contacts c2
                  WHERE c2.organisation_id = g.id
                    AND c2.erased_at IS NULL
                  ORDER BY %s
                  LIMIT 1
               )
               AND c.followers_count IS NOT NULL%s
          )`, existence, primaryContactOrder, test)
}

// scanner is what both a queue row and a single RETURNING row satisfy.
// Declared so the column list above is read back in exactly one place: a
// second Scan call written against `queueColumns` would be a second chance to
// get the ORDER of eleven values wrong, and a swapped pair of same-typed
// columns produces wrong data rather than an error.
type scanner interface{ Scan(dest ...any) error }

// scanOpportunity reads one row of `queueColumns`.
func scanOpportunity(row scanner) (domain.Opportunity, error) {
	var o domain.Opportunity
	var stage string
	if err := row.Scan(
		&o.ID, &o.OrganisationID, &o.OrganisationName,
		&o.Product, &stage, &o.Owner,
		&o.NextActionAt, &o.NextActionNote, &o.LastContactedAt,
		&o.QuietSince, &o.IsStarred,
	); err != nil {
		return domain.Opportunity{}, err
	}
	// Narrowed on the way OUT of the database as well as on the way in. The
	// crm_stage enum makes this unreachable, which is the point: if it ever
	// fires, the type gained a value without this module learning of it, and
	// the module should say so rather than carry an unknown stage into a
	// response the console parses strictly.
	parsed, err := domain.ParseStage(stage)
	if err != nil {
		return domain.Opportunity{}, fmt.Errorf("opportunity %s: %w", o.ID, err)
	}
	o.Stage = parsed
	return o, nil
}

func scanOpportunities(rows pgx.Rows) ([]domain.Opportunity, error) {
	defer rows.Close()
	out := make([]domain.Opportunity, 0, 16)
	for rows.Next() {
		o, err := scanOpportunity(rows)
		if err != nil {
			return nil, fmt.Errorf("reading an opportunity: %w", err)
		}
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		// Checked rather than assumed: a Next() loop that ends early because
		// the connection dropped looks exactly like one that ran out of rows,
		// and without this the caller would serve a short page as a complete
		// one.
		return nil, fmt.Errorf("reading the queue: %w", err)
	}
	return out, nil
}
