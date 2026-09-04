package repository_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// seed inserts tickets with controlled status, priority and updated_at.
//
// updated_at is written in the INSERT, and that is the only way it can be
// pinned. `pt_set_updated_at` is a BEFORE **UPDATE** trigger that assigns
// `NEW.updated_at := now()` unconditionally, so any attempt to set the column
// with an UPDATE is overwritten — an earlier version of this helper did
// exactly that, and every ticket silently ended up stamped with the moment of
// its own seeding. The ordering assertions still passed, because reverse
// insertion order happened to match the dates the fixture intended, which is
// precisely the kind of agreement that makes an ordering test worthless.
//
// An INSERT does not fire a BEFORE UPDATE trigger, so the value survives.
func seed(t *testing.T, pool *pgxpool.Pool, specs []spec) []string {
	t.Helper()
	ctx := context.Background()
	ids := make([]string, 0, len(specs))
	tenant := "3f2a1c94-0000-4000-8000-0000000000aa"

	for i, s := range specs {
		product := s.product
		if product == "" {
			product = "mark8ly"
		}
		var id string
		var stamped time.Time
		err := pool.QueryRow(ctx,
			`INSERT INTO platform_tickets
			   (product_id, tenant_id, ticket_number, subject, description,
			    status, priority, submitted_by_name, submitted_by_email, updated_at)
			 VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
			 RETURNING id::text, updated_at`,
			product, tenant, fmt.Sprintf("M8-%04d", i+1),
			s.subject, "description of "+s.subject,
			string(s.status), string(s.priority),
			"Merchant "+s.subject, "merchant@example.test", s.updatedAt,
		).Scan(&id, &stamped)
		if err != nil {
			t.Fatalf("seeding %q: %v", s.subject, err)
		}
		// Asserted, not assumed. This helper's whole value is that the column
		// the queue sorts on holds what the fixture said, and it silently did
		// not for the first version of this file.
		if !stamped.Equal(s.updatedAt) {
			t.Fatalf("seeding %q: updated_at = %s, want %s — the fixture is not pinning the sort column",
				s.subject, stamped, s.updatedAt)
		}
		ids = append(ids, id)
	}
	return ids
}

type spec struct {
	subject   string
	status    domain.Status
	priority  domain.Priority
	updatedAt time.Time
	product   string
}

func at(day int) time.Time {
	return time.Date(2026, 8, day, 12, 0, 0, 0, time.UTC)
}

func subjects(tickets []domain.Ticket) []string {
	out := make([]string, len(tickets))
	for i, t := range tickets {
		out[i] = t.Subject
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// queue is the fixture the ordering and paging tests share: every status
// bucket and every priority rank, with distinct updated_at values so the
// expected order is unambiguous.
func queue() []spec {
	return []spec{
		{subject: "closed-urgent", status: domain.StatusClosed, priority: domain.PriorityUrgent, updatedAt: at(9)},
		{subject: "open-low", status: domain.StatusOpen, priority: domain.PriorityLow, updatedAt: at(8)},
		{subject: "open-urgent-old", status: domain.StatusOpen, priority: domain.PriorityUrgent, updatedAt: at(1)},
		{subject: "resolved-high", status: domain.StatusResolved, priority: domain.PriorityHigh, updatedAt: at(7)},
		{subject: "progress-urgent", status: domain.StatusInProgress, priority: domain.PriorityUrgent, updatedAt: at(6)},
		{subject: "open-high", status: domain.StatusOpen, priority: domain.PriorityHigh, updatedAt: at(5)},
		{subject: "open-medium", status: domain.StatusOpen, priority: domain.PriorityMedium, updatedAt: at(4)},
	}
}

// wantOrder is the queue fixture in the order listPlatformTickets defines:
// live tickets first, then most urgent, then most recently updated.
var wantOrder = []string{
	"progress-urgent", // live, urgent, 6 Aug
	"open-urgent-old", // live, urgent, 1 Aug
	"open-high",       // live, high
	"open-medium",     // live, medium
	"open-low",        // live, low
	"closed-urgent",   // finished, urgent
	"resolved-high",   // finished, high
}

func TestTheQueueOrdersLiveThenUrgentThenRecent(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, queue())

	page, err := repository.List(context.Background(), pool, repository.Filter{}, 50, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	if got := subjects(page.Tickets); !equal(got, wantOrder) {
		t.Errorf("order =\n  %v\nwant\n  %v", got, wantOrder)
	}
}

func TestPagingForwardVisitsEveryTicketExactlyOnceInOrder(t *testing.T) {
	// The property a keyset predicate over a composite sort exists to provide,
	// and the one a subtly wrong predicate breaks silently: a ticket skipped at
	// a page boundary is invisible unless the whole queue is walked.
	//
	// A page size of 2 against a 7-row fixture crosses a bucket boundary, a
	// rank boundary and an updated_at boundary, which a page size of 5 would
	// not.
	pool := testdb.New(t)
	seed(t, pool, queue())
	ctx := context.Background()

	var walked []string
	cursor := ""
	for range 10 {
		page, err := repository.List(ctx, pool, repository.Filter{}, 2, cursor)
		if err != nil {
			t.Fatalf("List(cursor=%q): %v", cursor, err)
		}
		walked = append(walked, subjects(page.Tickets)...)
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}

	if !equal(walked, wantOrder) {
		t.Errorf("walking forward gave\n  %v\nwant\n  %v", walked, wantOrder)
	}
}

func TestPagingBackwardRetracesTheSamePath(t *testing.T) {
	// The half that is easy to get wrong and invisible when it is: the counts,
	// the totals and both cursors stay correct while the rows come back upside
	// down, or from the wrong end of the queue entirely.
	pool := testdb.New(t)
	seed(t, pool, queue())
	ctx := context.Background()

	// Walk to the last page, remembering each page's first cursor.
	var forwardCursors []string
	cursor := ""
	for range 10 {
		page, err := repository.List(ctx, pool, repository.Filter{}, 2, cursor)
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		forwardCursors = append(forwardCursors, cursor)
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(forwardCursors) < 3 {
		t.Fatalf("the fixture must produce at least three pages, got %d", len(forwardCursors))
	}

	// From the last page, walk back and collect.
	var backwards []string
	page, err := repository.List(ctx, pool, repository.Filter{}, 2, forwardCursors[len(forwardCursors)-1])
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	backwards = append(subjects(page.Tickets), backwards...)
	for page.PreviousCursor != "" {
		page, err = repository.List(ctx, pool, repository.Filter{}, 2, page.PreviousCursor)
		if err != nil {
			t.Fatalf("List(before): %v", err)
		}
		backwards = append(subjects(page.Tickets), backwards...)
	}

	if !equal(backwards, wantOrder) {
		t.Errorf("walking backward gave\n  %v\nwant\n  %v", backwards, wantOrder)
	}
}

func TestABackwardPageIsInDisplayOrder(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, queue())
	ctx := context.Background()

	first, err := repository.List(ctx, pool, repository.Filter{}, 2, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	second, err := repository.List(ctx, pool, repository.Filter{}, 2, first.NextCursor)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	back, err := repository.List(ctx, pool, repository.Filter{}, 2, second.PreviousCursor)
	if err != nil {
		t.Fatalf("List(before): %v", err)
	}

	if got := subjects(back.Tickets); !equal(got, subjects(first.Tickets)) {
		t.Errorf("paging back from page two gave %v, want page one %v", got, subjects(first.Tickets))
	}
}

func TestPrecedingCountTracksThePagesPosition(t *testing.T) {
	// What lets a caller render "3–4 of 7" without offset paging. Counted in
	// SQL because a cursor carries no position of its own.
	pool := testdb.New(t)
	seed(t, pool, queue())
	ctx := context.Background()

	cursor := ""
	for wantPreceding := 0; wantPreceding < 6; wantPreceding += 2 {
		page, err := repository.List(ctx, pool, repository.Filter{}, 2, cursor)
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if page.Preceding != wantPreceding {
			t.Errorf("preceding = %d, want %d", page.Preceding, wantPreceding)
		}
		if page.Total != 7 {
			t.Errorf("total = %d, want 7 on every page", page.Total)
		}
		cursor = page.NextCursor
	}
}

func TestTheFirstPageOffersNoWayBack(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, queue())

	page, err := repository.List(context.Background(), pool, repository.Filter{}, 2, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if page.PreviousCursor != "" {
		t.Error("the first page offered a previous cursor")
	}
	if page.NextCursor == "" {
		t.Error("a full page with more behind it must offer a next cursor")
	}
}

func TestTheLastPageOffersNoWayOn(t *testing.T) {
	// The boundary limit+1 exists for. Without it, a final page that happens
	// to be exactly `limit` long would advertise a next page that renders
	// empty.
	pool := testdb.New(t)
	seed(t, pool, queue()[:4])
	ctx := context.Background()

	page, err := repository.List(ctx, pool, repository.Filter{}, 2, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	last, err := repository.List(ctx, pool, repository.Filter{}, 2, page.NextCursor)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(last.Tickets) != 2 {
		t.Fatalf("the last page has %d rows; this test needs an exactly-full one", len(last.Tickets))
	}
	if last.NextCursor != "" {
		t.Error("an exactly-full last page advertised another page")
	}
}

func TestFiltersRunInSQLAheadOfTheLimit(t *testing.T) {
	// Filtering a fetched page in Go would answer "rows matching the filter
	// among the first N overall", silently dropping a match ranked below the
	// cut-off. `open-medium` is 4th in the queue, so a limit of 2 applied
	// before the filter would lose it.
	pool := testdb.New(t)
	seed(t, pool, queue())

	page, err := repository.List(context.Background(), pool,
		repository.Filter{Priority: string(domain.PriorityMedium)}, 2, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	if got := subjects(page.Tickets); !equal(got, []string{"open-medium"}) {
		t.Errorf("rows = %v, want the medium-priority ticket the limit would have cut", got)
	}
	if page.Total != 1 {
		t.Errorf("total = %d, want the filtered total", page.Total)
	}
}

func TestEveryFilterNarrows(t *testing.T) {
	pool := testdb.New(t)
	specs := queue()
	specs = append(specs, spec{
		subject: "other-product", status: domain.StatusOpen, priority: domain.PriorityHigh,
		updatedAt: at(3), product: "homechef",
	})
	seed(t, pool, specs)
	ctx := context.Background()

	cases := map[string]struct {
		filter repository.Filter
		want   int64
	}{
		"status":   {repository.Filter{Status: "open"}, 5},
		"priority": {repository.Filter{Priority: "urgent"}, 3},
		"product":  {repository.Filter{Product: "homechef"}, 1},
		"combined": {repository.Filter{Status: "open", Priority: "urgent"}, 1},
	}
	for name, c := range cases {
		page, err := repository.List(ctx, pool, c.filter, 50, "")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if page.Total != c.want {
			t.Errorf("%s: total = %d, want %d", name, page.Total, c.want)
		}
		if int64(len(page.Tickets)) != c.want {
			t.Errorf("%s: rows = %d, want %d", name, len(page.Tickets), c.want)
		}
	}
}

func TestAnEmptyQueuePagesHonestly(t *testing.T) {
	pool := testdb.New(t)

	page, err := repository.List(context.Background(), pool, repository.Filter{}, 50, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if page.Total != 0 || page.Preceding != 0 {
		t.Errorf("total=%d preceding=%d, want zeroes", page.Total, page.Preceding)
	}
	if page.NextCursor != "" || page.PreviousCursor != "" {
		t.Error("an empty queue offered a cursor")
	}
	if len(page.Tickets) != 0 {
		t.Errorf("rows = %v", subjects(page.Tickets))
	}
}

func TestAMalformedCursorIsRejectedBeforeAnyQueryRuns(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, queue())

	_, err := repository.List(context.Background(), pool, repository.Filter{}, 2, "not-a-cursor!!")

	if !errors.Is(err, paging.ErrMalformedCursor) {
		t.Errorf("err = %v, want ErrMalformedCursor — never a silent fall back to page one", err)
	}
}

func TestACursorFromAnotherListingIsRejected(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, queue())
	foreign, _ := paging.Encode(paging.Cursor{Key: []string{"2026-08-19T00:00:00Z", "x"}, Direction: paging.After})

	_, err := repository.List(context.Background(), pool, repository.Filter{}, 2, foreign)

	if !errors.Is(err, paging.ErrMalformedCursor) {
		t.Errorf("err = %v, want a rejection; a two-component cursor cannot anchor a four-component sort", err)
	}
}

func TestGetReadsOneTicket(t *testing.T) {
	pool := testdb.New(t)
	ids := seed(t, pool, queue()[:1])

	got, err := repository.Get(context.Background(), pool, ids[0])
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Subject != "closed-urgent" || got.Status != domain.StatusClosed {
		t.Errorf("ticket = %+v", got)
	}
}

func TestGetDistinguishesAbsentFromBroken(t *testing.T) {
	// The handler answers 404 for one and 500 for the other, and must not
	// decide that by inspecting an error string.
	pool := testdb.New(t)

	_, err := repository.Get(context.Background(), pool, "3f2a1c94-0000-4000-8000-000000000999")

	if !errors.Is(err, repository.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestTheThreadReadsOldestFirst(t *testing.T) {
	// A conversation, not a queue. The listing is newest-first; these are
	// different questions and neither order should be inferred from the other.
	pool := testdb.New(t)
	ids := seed(t, pool, queue()[:1])
	ctx := context.Background()

	for _, content := range []string{"first", "second", "third"} {
		if _, err := repository.InsertReply(ctx, pool, domain.Reply{
			TicketID: ids[0], AuthorType: domain.AuthorOperator,
			AuthorName: "Operator", AuthorEmail: "op@tesserix.test", Content: content,
		}); err != nil {
			t.Fatalf("InsertReply: %v", err)
		}
	}

	replies, err := repository.Replies(ctx, pool, ids[0])
	if err != nil {
		t.Fatalf("Replies: %v", err)
	}
	got := make([]string, len(replies))
	for i, r := range replies {
		got[i] = r.Content
	}
	if !equal(got, []string{"first", "second", "third"}) {
		t.Errorf("thread = %v, want oldest first", got)
	}
}

func TestAReplyWithAnUnknownAuthorTypeIsRefusedRatherThanRendered(t *testing.T) {
	// The CHECK constraint makes this unreachable, which is the point: if it
	// ever fires, the constraint was dropped, and a misattributed message is
	// worse than a failed read. Forced here by writing around the constraint.
	pool := testdb.New(t)
	ids := seed(t, pool, queue()[:1])
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `ALTER TABLE platform_ticket_replies DROP CONSTRAINT ptr_author_chk`); err != nil {
		t.Fatalf("dropping the constraint: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO platform_ticket_replies (ticket_id, author_type, author_name, content)
		 VALUES ($1::uuid, 'robot', 'Bot', 'beep')`, ids[0]); err != nil {
		t.Fatalf("inserting: %v", err)
	}

	if _, err := repository.Replies(ctx, pool, ids[0]); err == nil {
		t.Error("an unknown author_type was carried through into a response")
	}
}

func TestResolvingStampsResolvedAtOnce(t *testing.T) {
	pool := testdb.New(t)
	ids := seed(t, pool, []spec{{
		subject: "open", status: domain.StatusOpen, priority: domain.PriorityHigh, updatedAt: at(1),
	}})
	ctx := context.Background()

	resolved, err := repository.SetStatus(ctx, pool, ids[0], domain.StatusResolved)
	if err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	if resolved.ResolvedAt == nil {
		t.Fatal("resolving did not stamp resolved_at")
	}
	first := *resolved.ResolvedAt

	// Bounce it and resolve again. resolved_at records WHEN a ticket was
	// first resolved; restamping would quietly reset the "how long did this
	// take" clock.
	if _, err := repository.SetStatus(ctx, pool, ids[0], domain.StatusInProgress); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	again, err := repository.SetStatus(ctx, pool, ids[0], domain.StatusResolved)
	if err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	if again.ResolvedAt == nil || !again.ResolvedAt.Equal(first) {
		t.Errorf("resolved_at = %v, want the original %v", again.ResolvedAt, first)
	}
}

func TestClosingAnUnresolvedTicketDoesNotStampResolvedAt(t *testing.T) {
	// A ticket closed as a duplicate or withdrawn was never answered.
	// Stamping it would put it in the resolved-this-week count.
	pool := testdb.New(t)
	ids := seed(t, pool, []spec{{
		subject: "open", status: domain.StatusOpen, priority: domain.PriorityLow, updatedAt: at(1),
	}})

	closed, err := repository.SetStatus(context.Background(), pool, ids[0], domain.StatusClosed)
	if err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	if closed.ResolvedAt != nil {
		t.Errorf("resolved_at = %v, want NULL", closed.ResolvedAt)
	}
}

func TestSetStatusOnAnAbsentTicketIsNotFound(t *testing.T) {
	pool := testdb.New(t)

	_, err := repository.SetStatus(context.Background(), pool,
		"3f2a1c94-0000-4000-8000-000000000999", domain.StatusResolved)

	if !errors.Is(err, repository.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestTheSummaryIsOfTheWholeQueue(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, queue())

	got, err := repository.Summary(context.Background(), pool, "")
	if err != nil {
		t.Fatalf("Summary: %v", err)
	}
	want := domain.Summary{Open: 4, InProgress: 1, ResolvedThisWeek: 0, UrgentOpen: 2}
	if got != want {
		t.Errorf("summary = %+v, want %+v", got, want)
	}
}

func TestResolvedThisWeekIsAWindowAndNotACount(t *testing.T) {
	// The column it reads is resolved_at, not status: a ticket resolved two
	// months ago is still `resolved` and must not be in this week's number.
	pool := testdb.New(t)
	ids := seed(t, pool, []spec{
		{subject: "recent", status: domain.StatusOpen, priority: domain.PriorityLow, updatedAt: at(1)},
		{subject: "old", status: domain.StatusOpen, priority: domain.PriorityLow, updatedAt: at(1)},
	})
	ctx := context.Background()

	for _, id := range ids {
		if _, err := repository.SetStatus(ctx, pool, id, domain.StatusResolved); err != nil {
			t.Fatalf("SetStatus: %v", err)
		}
	}
	if _, err := pool.Exec(ctx,
		`UPDATE platform_tickets SET resolved_at = now() - interval '60 days' WHERE id = $1::uuid`,
		ids[1]); err != nil {
		t.Fatalf("ageing: %v", err)
	}

	got, err := repository.Summary(ctx, pool, "")
	if err != nil {
		t.Fatalf("Summary: %v", err)
	}
	if got.ResolvedThisWeek != 1 {
		t.Errorf("resolvedThisWeek = %d, want 1 — the one resolved inside the window", got.ResolvedThisWeek)
	}
}

// The summary cannot be narrowed, and that is enforced by the signature
// rather than by a test: Summary takes no Filter. Recorded here because the
// absence is deliberate — the console's contract test asserts the headline
// numbers do not move as an operator narrows the list, and the cheapest way to
// keep that true is to give a caller no way to ask for anything else.
var _ = repository.Summary

func TestPagingAFilteredQueueKeepsTheFilterOnEveryPage(t *testing.T) {
	// The path where the filter clause and the keyset clause combine. Nothing
	// above reached it: the filter tests fit on one page and the paging tests
	// were unfiltered, so a bug that dropped the filter on page two — or one
	// that mis-numbered a parameter when both clauses are present — would have
	// passed everything.
	//
	// The failure it guards is specific and quiet: page one honours the filter,
	// page two silently widens to the whole queue.
	pool := testdb.New(t)
	specs := queue()
	specs = append(specs,
		spec{subject: "open-urgent-2", status: domain.StatusOpen, priority: domain.PriorityUrgent, updatedAt: at(3)},
		spec{subject: "open-urgent-3", status: domain.StatusOpen, priority: domain.PriorityUrgent, updatedAt: at(2)},
	)
	seed(t, pool, specs)
	ctx := context.Background()

	var walked []string
	cursor := ""
	filter := repository.Filter{Status: string(domain.StatusOpen), Priority: string(domain.PriorityUrgent)}
	for range 10 {
		page, err := repository.List(ctx, pool, filter, 1, cursor)
		if err != nil {
			t.Fatalf("List(cursor=%q): %v", cursor, err)
		}
		if page.Total != 3 {
			t.Errorf("total = %d, want the filtered total on every page", page.Total)
		}
		walked = append(walked, subjects(page.Tickets)...)
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}

	want := []string{"open-urgent-2", "open-urgent-3", "open-urgent-old"}
	if !equal(walked, want) {
		t.Errorf("walking a filtered queue gave\n  %v\nwant\n  %v", walked, want)
	}
}

func TestPagingBackwardThroughAFilteredQueue(t *testing.T) {
	// The same combination in the other direction, where the parameter
	// numbering differs again because the comparison flips.
	pool := testdb.New(t)
	specs := queue()
	specs = append(specs,
		spec{subject: "open-urgent-2", status: domain.StatusOpen, priority: domain.PriorityUrgent, updatedAt: at(3)},
	)
	seed(t, pool, specs)
	ctx := context.Background()
	filter := repository.Filter{Status: string(domain.StatusOpen), Priority: string(domain.PriorityUrgent)}

	first, err := repository.List(ctx, pool, filter, 1, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	second, err := repository.List(ctx, pool, filter, 1, first.NextCursor)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	back, err := repository.List(ctx, pool, filter, 1, second.PreviousCursor)
	if err != nil {
		t.Fatalf("List(before): %v", err)
	}

	if !equal(subjects(back.Tickets), subjects(first.Tickets)) {
		t.Errorf("paging back gave %v, want page one %v", subjects(back.Tickets), subjects(first.Tickets))
	}
	if back.Total != 2 {
		t.Errorf("total = %d, want the filtered total when paging backward", back.Total)
	}
}

// #152. The summary is the one read whose scoping lives in SQL rather than in
// Scope, so it is the one that a pure test cannot reach.
//
// Both directions matter. A scoped summary that failed to filter would report
// the estate's open count to a caller that cannot read a single one of those
// tickets; an unscoped one that started filtering would silently empty the
// console's queue header.
func TestTheSummaryIsConfinedToOneProductWhenAsked(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, []spec{
		{subject: "m-open-urgent", product: "mark8ly", status: domain.StatusOpen, priority: domain.PriorityUrgent, updatedAt: at(3)},
		{subject: "k-open-urgent", product: "kora", status: domain.StatusOpen, priority: domain.PriorityUrgent, updatedAt: at(2)},
		{subject: "k-open-low", product: "kora", status: domain.StatusOpen, priority: domain.PriorityLow, updatedAt: at(1)},
	})
	ctx := context.Background()

	scoped, err := repository.Summary(ctx, pool, "mark8ly")
	if err != nil {
		t.Fatalf("scoped Summary: %v", err)
	}
	if want := (domain.Summary{Open: 1, UrgentOpen: 1}); scoped != want {
		t.Errorf("scoped summary = %+v, want %+v — a product must not be counted another's tickets", scoped, want)
	}

	estate, err := repository.Summary(ctx, pool, "")
	if err != nil {
		t.Fatalf("estate Summary: %v", err)
	}
	if want := (domain.Summary{Open: 3, UrgentOpen: 2}); estate != want {
		t.Errorf("estate summary = %+v, want %+v — the empty product must still mean the whole queue", estate, want)
	}
}
