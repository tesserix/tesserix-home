package repository_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
)

// ---------------------------------------------------------------------------
// The two queues' own predicates
// ---------------------------------------------------------------------------

func TestDueSurfacesArrivedActionsMostOverdueFirstAndNothingElse(t *testing.T) {
	w := newWorld(t)
	w.org(orgSpec{name: "acme"})
	w.opportunity(oppSpec{org: "acme", label: "due-3h", nextActionAt: w.ago(3 * time.Hour)})
	w.opportunity(oppSpec{org: "acme", label: "due-1d", nextActionAt: w.ago(day)})
	w.opportunity(oppSpec{org: "acme", label: "due-1m", nextActionAt: w.ago(time.Minute)})
	// Excluded, each for its own reason.
	w.opportunity(oppSpec{org: "acme", label: "not-yet", nextActionAt: w.hence(day)})
	w.opportunity(oppSpec{org: "acme", label: "nothing-scheduled"})
	w.opportunity(oppSpec{org: "acme", label: "already-won",
		stage: domain.StageWon, product: ptr("mark8ly"), nextActionAt: w.ago(2 * day)})
	w.opportunity(oppSpec{org: "acme", label: "already-lost",
		stage: domain.StageLost, product: ptr("mark8ly"), nextActionAt: w.ago(2 * day)})

	page, err := repository.Due(w.ctx, w.pool, domain.Filter{}, 50, "")
	if err != nil {
		t.Fatalf("Due: %v", err)
	}
	want := []string{"due-1d", "due-3h", "due-1m"}
	if got := labels(page.Opportunities); !equal(got, want) {
		t.Errorf("order =\n  %v\nwant\n  %v", got, want)
	}
	if page.Total != 3 {
		t.Errorf("Total = %d, want 3", page.Total)
	}
}

func TestDriftingRequiresBothNoNextActionAndAStaleQuietSince(t *testing.T) {
	// The AND is the whole rule. An OR would surface every scheduled lead as
	// drifting the moment it went quiet, which is the opposite of the point.
	w := newWorld(t)
	w.org(orgSpec{name: "acme"})
	w.opportunity(oppSpec{org: "acme", label: "quiet-30d", lastContactedAt: w.ago(30 * day)})
	w.opportunity(oppSpec{org: "acme", label: "quiet-8d", lastContactedAt: w.ago(8 * day)})
	w.opportunity(oppSpec{org: "acme", label: "contacted-yesterday", lastContactedAt: w.ago(day)})
	w.opportunity(oppSpec{org: "acme", label: "quiet-but-scheduled",
		lastContactedAt: w.ago(30 * day), nextActionAt: w.hence(5 * day)})
	w.opportunity(oppSpec{org: "acme", label: "quiet-but-won",
		stage: domain.StageWon, product: ptr("mark8ly"), lastContactedAt: w.ago(30 * day)})

	page, err := repository.Drifting(w.ctx, w.pool, domain.Filter{}, 7, 50, "")
	if err != nil {
		t.Fatalf("Drifting: %v", err)
	}
	want := []string{"quiet-30d", "quiet-8d"}
	if got := labels(page.Opportunities); !equal(got, want) {
		t.Errorf("rows =\n  %v\nwant\n  %v", got, want)
	}
}

func TestDriftingMeasuresANeverContactedLeadFromWhenItArrived(t *testing.T) {
	// COALESCE(last_contacted_at, created_at). Without it every freshly
	// imported lead — NULL last_contacted_at, no next action — would be
	// instantly drifting, flooding the queue the moment an import finishes.
	w := newWorld(t)
	w.org(orgSpec{name: "acme"})
	w.opportunity(oppSpec{org: "acme", label: "imported-a-month-ago", createdAt: w.ago(30 * day)})
	w.opportunity(oppSpec{org: "acme", label: "imported-an-hour-ago", createdAt: w.ago(time.Hour)})

	page, err := repository.Drifting(w.ctx, w.pool, domain.Filter{}, 7, 50, "")
	if err != nil {
		t.Fatalf("Drifting: %v", err)
	}
	if got := labels(page.Opportunities); !equal(got, []string{"imported-a-month-ago"}) {
		t.Errorf("rows = %v, want [imported-a-month-ago]", got)
	}
	// The row reports the instant the order and the staleness were measured
	// from, so a caller renders the order it was given rather than recomputing
	// the COALESCE and risking two copies that disagree.
	if got := page.Opportunities[0].QuietSince.UTC(); got.Sub(*w.ago(30 * day)).Abs() > time.Second {
		t.Errorf("QuietSince = %s, want the created_at the fixture wrote", got)
	}
}

func TestDriftingIncludesARowExactlyOnTheStaleBoundary(t *testing.T) {
	// `<=`, so the row whose quiet_since is exactly the window's edge is IN.
	// The margin is a minute rather than a tick: now() at query time is later
	// than the fixture's captured instant by however long seeding took, which
	// pushes the exact-boundary row further inside the window and the
	// just-inside row no further out.
	w := newWorld(t)
	w.org(orgSpec{name: "acme"})
	w.opportunity(oppSpec{org: "acme", label: "exactly-7d", lastContactedAt: w.ago(7 * day)})
	w.opportunity(oppSpec{org: "acme", label: "one-minute-short",
		lastContactedAt: w.ago(7*day - time.Minute)})

	page, err := repository.Drifting(w.ctx, w.pool, domain.Filter{}, 7, 50, "")
	if err != nil {
		t.Fatalf("Drifting: %v", err)
	}
	if got := labels(page.Opportunities); !equal(got, []string{"exactly-7d"}) {
		t.Errorf("rows = %v, want [exactly-7d]", got)
	}
}

// ---------------------------------------------------------------------------
// The follower band: a correlated subquery, not a column predicate
// ---------------------------------------------------------------------------

// followerWorld gives each organisation one due opportunity labelled with the
// organisation's own name, so a filter's result reads as a list of orgs.
func followerWorld(t *testing.T) *world {
	w := newWorld(t)
	// The primary is the OLDER contact — neither is flagged — so this row also
	// pins the created_at tiebreak in primaryContactOrder. Its secondary
	// contact is deliberately in a different band.
	w.org(orgSpec{name: "small-primary", contacts: []contactSpec{
		{followers: ptr(500), createdAt: w.base.Add(-2 * day)},
		{followers: ptr(50000), createdAt: w.base.Add(-day)},
	}})
	// Here the FLAGGED contact is the younger one, so is_primary must win over
	// created_at.
	w.org(orgSpec{name: "big-primary", contacts: []contactSpec{
		{followers: ptr(10), createdAt: w.base.Add(-2 * day)},
		{followers: ptr(50000), primary: true, createdAt: w.base.Add(-day)},
	}})
	// A primary with no count, beside a secondary that has one. The row shows
	// a blank cell, so it belongs to "unset" and to no band.
	w.org(orgSpec{name: "unmeasured-primary", contacts: []contactSpec{
		{followers: nil, primary: true, createdAt: w.base.Add(-2 * day)},
		{followers: ptr(5000), createdAt: w.base.Add(-day)},
	}})
	// No contacts at all: nothing to show either, so it is unset as well.
	w.org(orgSpec{name: "no-contacts"})

	for i, name := range []string{"small-primary", "big-primary", "unmeasured-primary", "no-contacts"} {
		w.opportunity(oppSpec{org: name, label: name, nextActionAt: w.ago(time.Duration(10-i) * day)})
	}
	return w
}

func TestTheFollowerBandTestsThePrimaryContactNotAnyContact(t *testing.T) {
	// The obvious wrong query — EXISTS over every contact — would put
	// small-primary in the 10k+ band on the strength of a contact the row does
	// not display, and the same organisation would then appear under two
	// bands.
	w := followerWorld(t)
	for _, tc := range []struct {
		band domain.FollowerBand
		want []string
	}{
		{domain.FollowersUnder1k, []string{"small-primary"}},
		{domain.Followers1kTo10k, nil},
		{domain.FollowersOver10k, []string{"big-primary"}},
	} {
		t.Run(string(tc.band), func(t *testing.T) {
			page, err := repository.Due(w.ctx, w.pool,
				domain.Filter{Followers: domain.Is(string(tc.band))}, 50, "")
			if err != nil {
				t.Fatalf("Due: %v", err)
			}
			if got := labels(page.Opportunities); !equal(got, tc.want) {
				t.Errorf("rows = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTheBandsAndUnsetPartitionEveryRow(t *testing.T) {
	// The property the unset option exists to restore: before it, 51
	// production organisations were reachable from no follower value at all,
	// with nothing on the surface saying so. Asserted as a partition — every
	// row in exactly one bucket — rather than as four independent results,
	// because a double-count and a gap are the two ways this breaks and only
	// one of them shows up in a single-bucket assertion.
	w := followerWorld(t)
	seen := map[string]string{}
	buckets := map[string]domain.Match{
		"under1k": domain.Is("under1k"),
		"k1to10k": domain.Is("k1to10k"),
		"over10k": domain.Is("over10k"),
		"unset":   domain.Unset(),
	}
	for bucket, match := range buckets {
		page, err := repository.Due(w.ctx, w.pool, domain.Filter{Followers: match}, 50, "")
		if err != nil {
			t.Fatalf("Due(%s): %v", bucket, err)
		}
		for _, label := range labels(page.Opportunities) {
			if other, ok := seen[label]; ok {
				t.Errorf("%q is in both %q and %q", label, other, bucket)
			}
			seen[label] = bucket
		}
	}
	for _, label := range []string{"small-primary", "big-primary", "unmeasured-primary", "no-contacts"} {
		if _, ok := seen[label]; !ok {
			t.Errorf("%q is reachable from no follower option at all", label)
		}
	}
	if got := seen["unmeasured-primary"]; got != "unset" {
		t.Errorf("unmeasured-primary is in %q; a primary with no count is unset, whatever its colleagues have", got)
	}
	if got := seen["no-contacts"]; got != "unset" {
		t.Errorf("no-contacts is in %q; an organisation with nothing to show has nothing to show", got)
	}
}

func TestTheBandEdgesAreInclusiveOnBothSides(t *testing.T) {
	w := newWorld(t)
	for _, edge := range []struct {
		name  string
		count int
	}{{"999", 999}, {"1000", 1000}, {"9999", 9999}, {"10000", 10000}} {
		w.org(orgSpec{name: edge.name, contacts: []contactSpec{{primary: true, followers: ptr(edge.count)}}})
		w.opportunity(oppSpec{org: edge.name, label: edge.name, nextActionAt: w.ago(day)})
	}
	for _, tc := range []struct {
		band string
		want []string
	}{
		{"under1k", []string{"999"}},
		{"k1to10k", []string{"1000", "9999"}},
		{"over10k", []string{"10000"}},
	} {
		page, err := repository.Due(w.ctx, w.pool, domain.Filter{Followers: domain.Is(tc.band)}, 50, "")
		if err != nil {
			t.Fatalf("Due(%s): %v", tc.band, err)
		}
		got := labels(page.Opportunities)
		if len(got) != len(tc.want) {
			t.Errorf("%s = %v, want %v", tc.band, got, tc.want)
			continue
		}
		for _, want := range tc.want {
			if !strings.Contains(strings.Join(got, ","), want) {
				t.Errorf("%s = %v, want it to contain %q", tc.band, got, want)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// The five axes
// ---------------------------------------------------------------------------

// filterWorld carries one row per interesting combination, each due at a
// distinct instant so every result below has an unambiguous order.
func filterWorld(t *testing.T) *world {
	w := newWorld(t)
	w.org(orgSpec{name: "india", country: ptr("IN"),
		contacts: []contactSpec{{primary: true, followers: ptr(5000)}}})
	w.org(orgSpec{name: "australia", country: ptr("AU"),
		contacts: []contactSpec{{primary: true, followers: ptr(100)}}})
	w.org(orgSpec{name: "nowhere"})

	w.opportunity(oppSpec{org: "india", label: "a", product: ptr("mark8ly"),
		stage: domain.StageNew, owner: ptr("Mahesh Sangawar"), nextActionAt: w.ago(5 * day)})
	w.opportunity(oppSpec{org: "australia", label: "b",
		stage: domain.StageContacted, owner: ptr("priya"), nextActionAt: w.ago(4 * day)})
	w.opportunity(oppSpec{org: "nowhere", label: "c", product: ptr("kora"),
		stage: domain.StageQualified, owner: ptr("100% Committed"), nextActionAt: w.ago(3 * day)})
	w.opportunity(oppSpec{org: "india", label: "d",
		stage: domain.StageNew, nextActionAt: w.ago(2 * day)})
	return w
}

func TestEachFilterAxisNarrowsOnItsOwn(t *testing.T) {
	w := filterWorld(t)
	for _, tc := range []struct {
		name   string
		filter domain.Filter
		want   []string
	}{
		{"product", domain.Filter{Product: domain.Is("mark8ly")}, []string{"a"}},
		// The busiest option on this axis, not an edge case: every import and
		// every migrated lead lands with a null product.
		{"product unset", domain.Filter{Product: domain.Unset()}, []string{"b", "d"}},
		{"stage", domain.Filter{Stage: domain.StageContacted}, []string{"b"}},
		// Case-insensitive substring, matching the console.
		{"owner", domain.Filter{Owner: "mahesh"}, []string{"a"}},
		// The escaping. Unescaped, "%" is a LIKE wildcard and would match
		// every row with a non-null owner — a filter that silently means
		// "everything" is worse than one that matches nothing.
		{"owner with a literal percent", domain.Filter{Owner: "%"}, []string{"c"}},
		{"owner with a literal underscore", domain.Filter{Owner: "_"}, nil},
		{"country", domain.Filter{Country: domain.Is("IN")}, []string{"a", "d"}},
		{"country unset", domain.Filter{Country: domain.Unset()}, []string{"c"}},
		{"followers", domain.Filter{Followers: domain.Is("k1to10k")}, []string{"a", "d"}},
		{"followers unset", domain.Filter{Followers: domain.Unset()}, []string{"c"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			page, err := repository.Due(w.ctx, w.pool, tc.filter, 50, "")
			if err != nil {
				t.Fatalf("Due: %v", err)
			}
			if got := labels(page.Opportunities); !equal(got, tc.want) {
				t.Errorf("rows = %v, want %v", got, tc.want)
			}
			if page.Total != int64(len(tc.want)) {
				t.Errorf("Total = %d, want %d — the count and the rows must describe one set",
					page.Total, len(tc.want))
			}
		})
	}
}

func TestFiltersCombineAsAConjunction(t *testing.T) {
	w := filterWorld(t)
	for _, tc := range []struct {
		name   string
		filter domain.Filter
		want   []string
	}{
		{"country and unset product", domain.Filter{Country: domain.Is("IN"), Product: domain.Unset()}, []string{"d"}},
		{"country and owner", domain.Filter{Country: domain.Is("IN"), Owner: "sangawar"}, []string{"a"}},
		{"a combination nothing satisfies", domain.Filter{Country: domain.Is("AU"), Stage: domain.StageQualified}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			page, err := repository.Due(w.ctx, w.pool, tc.filter, 50, "")
			if err != nil {
				t.Fatalf("Due: %v", err)
			}
			if got := labels(page.Opportunities); !equal(got, tc.want) {
				t.Errorf("rows = %v, want %v", got, tc.want)
			}
		})
	}
}

// The filters apply to the DRIFTING queue too — the same builder, spliced
// after a different predicate. Checked because a shared builder that only one
// caller actually passes through is a shared builder in name only.
func TestTheSameFiltersNarrowTheDriftingQueue(t *testing.T) {
	w := newWorld(t)
	w.org(orgSpec{name: "india", country: ptr("IN")})
	w.org(orgSpec{name: "nowhere"})
	w.opportunity(oppSpec{org: "india", label: "quiet-in", lastContactedAt: w.ago(30 * day)})
	w.opportunity(oppSpec{org: "nowhere", label: "quiet-nowhere", lastContactedAt: w.ago(20 * day)})

	page, err := repository.Drifting(w.ctx, w.pool, domain.Filter{Country: domain.Is("IN")}, 7, 50, "")
	if err != nil {
		t.Fatalf("Drifting: %v", err)
	}
	if got := labels(page.Opportunities); !equal(got, []string{"quiet-in"}) {
		t.Errorf("rows = %v, want [quiet-in]", got)
	}
	if page.Total != 1 {
		t.Errorf("Total = %d, want 1", page.Total)
	}
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

// pagedWorld is seven due opportunities, ordered a..g, sharing one instant in
// the middle so the `o.id` tiebreak is exercised rather than assumed.
func pagedWorld(t *testing.T) *world {
	w := newWorld(t)
	w.org(orgSpec{name: "acme"})
	for i, label := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		w.opportunity(oppSpec{org: "acme", label: label, nextActionAt: w.ago(time.Duration(20-i) * day)})
	}
	return w
}

func TestPagingForwardVisitsEveryOpportunityExactlyOnceInOrder(t *testing.T) {
	// The property a keyset predicate exists to provide, and the one a subtly
	// wrong predicate breaks silently: a row skipped at a page boundary is
	// invisible unless the whole queue is walked.
	w := pagedWorld(t)
	var walked []string
	cursor := ""
	for range 10 {
		page, err := repository.Due(w.ctx, w.pool, domain.Filter{}, 2, cursor)
		if err != nil {
			t.Fatalf("Due(cursor=%q): %v", cursor, err)
		}
		walked = append(walked, labels(page.Opportunities)...)
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	want := []string{"a", "b", "c", "d", "e", "f", "g"}
	if !equal(walked, want) {
		t.Errorf("walked\n  %v\nwant\n  %v", walked, want)
	}
}

func TestAMiddlePageCountsItsTotalAndItsPosition(t *testing.T) {
	// Both SQL-counted. A keyset cursor names an anchor row, not an offset, so
	// neither number is recoverable by arithmetic from the cursor.
	w := pagedWorld(t)
	cursor := ""
	for page := 1; page <= 3; page++ {
		got, err := repository.Due(w.ctx, w.pool, domain.Filter{}, 2, cursor)
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		if got.Total != 7 {
			t.Errorf("page %d: Total = %d, want 7", page, got.Total)
		}
		if want := (page - 1) * 2; got.Preceding != want {
			t.Errorf("page %d: Preceding = %d, want %d", page, got.Preceding, want)
		}
		// The first page has nothing ahead of it and says so; every later page
		// offers a way back.
		if (got.PreviousCursor != "") != (page > 1) {
			t.Errorf("page %d: PreviousCursor = %q", page, got.PreviousCursor)
		}
		cursor = got.NextCursor
	}
}

func TestABackwardPageComesBackInDisplayOrderWithACorrectedPreceding(t *testing.T) {
	// The asymmetry paging.Resolve owns: a backward fetch runs with a flipped
	// ORDER BY, so it arrives nearest-anchor-first and must be re-reversed,
	// and its SQL count covers this page as well as everything ahead of it.
	// Both failures are silent — the page renders upside down, or the position
	// is off by exactly one page — so this walks to page three and steps back.
	w := pagedWorld(t)
	first, err := repository.Due(w.ctx, w.pool, domain.Filter{}, 2, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	second, err := repository.Due(w.ctx, w.pool, domain.Filter{}, 2, first.NextCursor)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	third, err := repository.Due(w.ctx, w.pool, domain.Filter{}, 2, second.NextCursor)
	if err != nil {
		t.Fatalf("page 3: %v", err)
	}
	back, err := repository.Due(w.ctx, w.pool, domain.Filter{}, 2, third.PreviousCursor)
	if err != nil {
		t.Fatalf("stepping back from page 3: %v", err)
	}
	if got := labels(back.Opportunities); !equal(got, labels(second.Opportunities)) {
		t.Errorf("back = %v, want page two's %v in the same order", got, labels(second.Opportunities))
	}
	if back.Preceding != 2 {
		t.Errorf("Preceding = %d, want 2 — the backward count was not corrected by the page's own length", back.Preceding)
	}
	if back.Total != 7 {
		t.Errorf("Total = %d, want 7", back.Total)
	}
	// A page reached from behind has, by construction, a page ahead: the one
	// whose cursor was followed.
	if back.NextCursor == "" {
		t.Error("NextCursor is empty on a page that was reached from the page after it")
	}
	if back.PreviousCursor == "" {
		t.Error("PreviousCursor is empty on page two")
	}
}

func TestAnEmptyResultStillReportsItsCounts(t *testing.T) {
	// Zero is an answer — "nothing matches your filter" — and it must be
	// distinguishable from "this endpoint does not count". The counts are
	// present and zero; the cursors are absent, because an empty page that
	// offered one would promise a neighbour it cannot name a row for.
	w := filterWorld(t)
	page, err := repository.Due(w.ctx, w.pool, domain.Filter{Product: domain.Is("no-such-product")}, 50, "")
	if err != nil {
		t.Fatalf("Due: %v", err)
	}
	if len(page.Opportunities) != 0 {
		t.Fatalf("rows = %v, want none", labels(page.Opportunities))
	}
	if page.Opportunities == nil {
		t.Error("rows is nil; an empty collection must stay a collection so it serialises as []")
	}
	if page.Total != 0 || page.Preceding != 0 {
		t.Errorf("Total = %d, Preceding = %d, want 0 and 0", page.Total, page.Preceding)
	}
	if page.NextCursor != "" || page.PreviousCursor != "" {
		t.Errorf("cursors = %q/%q, want neither", page.NextCursor, page.PreviousCursor)
	}
}

// ---------------------------------------------------------------------------
// Refusals, all of which happen before a round trip is spent
// ---------------------------------------------------------------------------

// refusing fails the test if the repository reaches the database at all. That
// is the assertion: a filter or a cursor the module cannot honour must be
// refused BEFORE the count query, not after it.
type refusing struct{ t *testing.T }

func (r refusing) Query(context.Context, string, ...any) (pgx.Rows, error) {
	r.t.Fatal("a query ran; the input should have been refused before any round trip")
	return nil, nil
}

func (r refusing) QueryRow(context.Context, string, ...any) pgx.Row {
	r.t.Fatal("a query ran; the input should have been refused before any round trip")
	return nil
}

func TestAnInvalidFilterIsRefusedBeforeAnyQueryRuns(t *testing.T) {
	db := refusing{t}
	for _, tc := range []struct {
		name   string
		filter domain.Filter
	}{
		{"unknown stage", domain.Filter{Stage: domain.Stage("archived")}},
		{"unknown follower band", domain.Filter{Followers: domain.Is("massive")}},
		{"country that is not alpha-2", domain.Filter{Country: domain.Is("india")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := repository.Due(context.Background(), db, tc.filter, 50, ""); err == nil {
				t.Error("Due accepted the filter")
			}
			if _, err := repository.Drifting(context.Background(), db, tc.filter, 7, 50, ""); err == nil {
				t.Error("Drifting accepted the filter")
			}
		})
	}
}

func TestAMalformedCursorIsRefusedBeforeAnyQueryRuns(t *testing.T) {
	_, err := repository.Due(context.Background(), refusing{t}, domain.Filter{}, 50, "not-a-cursor")
	if !errors.Is(err, paging.ErrMalformedCursor) {
		t.Errorf("err = %v, want a malformed-cursor rejection", err)
	}
}

func TestACursorFromAListingThatSortsDifferentlyIsRejected(t *testing.T) {
	// The ticket queue sorts on four components; these queues sort on two. A
	// four-component key bound positionally against two columns is a page
	// rendered from the wrong anchor and reported as a success, which is the
	// failure the length check exists to turn into a 400.
	foreign, err := paging.Encode(paging.Cursor{
		Direction: paging.After,
		Key:       []string{"0", "1", "2026-08-20T00:00:00Z", "3f2a1c94-0000-4000-8000-0000000000aa"},
	})
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if _, err := repository.Due(context.Background(), refusing{t}, domain.Filter{}, 50, foreign); !errors.Is(err, paging.ErrMalformedCursor) {
		t.Errorf("err = %v, want a malformed-cursor rejection", err)
	}
}

func TestANegativeStaleWindowIsRefusedBeforeAnyQueryRuns(t *testing.T) {
	// It asks for rows quiet since the future, which is empty — and answering
	// "no drifting leads" to a caller bug is the silent success this package
	// spends its validation on avoiding.
	if _, err := repository.Drifting(context.Background(), refusing{t}, domain.Filter{}, -1, 50, ""); err == nil {
		t.Error("Drifting accepted a negative staleness window")
	}
}
