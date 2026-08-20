package paging_test

import (
	"strconv"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
)

// row is a stand-in for a domain type. Its key is one component, because what
// is under test here is the assembly around the key, not the key itself — the
// four-component version is exercised against the real schema in the tickets
// repository tests.
type row struct{ n int }

func key(r row) []string { return []string{strconv.Itoa(r.n)} }

func rows(ns ...int) []row {
	out := make([]row, len(ns))
	for i, n := range ns {
		out[i] = row{n}
	}
	return out
}

func numbers(rs []row) []int {
	out := make([]int, len(rs))
	for i, r := range rs {
		out[i] = r.n
	}
	return out
}

func equalInts(a, b []int) bool {
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

func mustDecode(t *testing.T, raw string) paging.Cursor {
	t.Helper()
	c, err := paging.Decode(raw, 1)
	if err != nil {
		t.Fatalf("Decode(%q): %v", raw, err)
	}
	return c
}

func TestAFirstPageReportsItsCountsAndOnlyAForwardCursor(t *testing.T) {
	page, err := paging.Resolve(rows(1, 2, 3), 2, nil, &paging.Counts{Total: 9, Preceding: 0}, key)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got := numbers(page.Rows); !equalInts(got, []int{1, 2}) {
		t.Errorf("rows = %v, want [1 2]", got)
	}
	if page.Counts == nil || page.Counts.Total != 9 || page.Counts.Preceding != 0 {
		t.Errorf("counts = %+v, want total 9 preceding 0", page.Counts)
	}
	if page.PreviousCursor != "" {
		t.Error("the first page offered a way back")
	}
	if page.NextCursor == "" {
		t.Fatal("a page with a proof row offered no next cursor")
	}
	next := mustDecode(t, page.NextCursor)
	if next.Direction != paging.After || next.Key[0] != "2" {
		t.Errorf("next cursor = %+v, want after row 2", next)
	}
}

// The distinction httpx.Meta spends pointers to keep: an empty result still
// reports its counts, and a listing that opted out reports none. A plain int
// could not tell the two apart.
func TestZeroCountsAreReportedAndOptingOutIsNot(t *testing.T) {
	empty, err := paging.Resolve(rows(), 2, nil, &paging.Counts{}, key)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if empty.Counts == nil {
		t.Fatal("a counted empty page reported no counts; zero is an answer")
	}
	if empty.Counts.Total != 0 || empty.NextCursor != "" || empty.PreviousCursor != "" {
		t.Errorf("empty page = %+v", empty)
	}

	uncounted, err := paging.Resolve(rows(1, 2, 3), 2, nil, nil, key)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if uncounted.Counts != nil {
		t.Errorf("opting out produced counts: %+v", uncounted.Counts)
	}
	if uncounted.NextCursor == "" {
		t.Error("opting out of counts also lost the forward cursor")
	}
}

// Without counts there is no Preceding to consult, so the cursor's existence
// is what says a page lies behind this one.
func TestAnUncountedForwardPageStillOffersAWayBack(t *testing.T) {
	anchor := mustDecode(t, encode(t, paging.After, "7"))
	page, err := paging.Resolve(rows(8, 9), 2, &anchor, nil, key)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if page.PreviousCursor == "" {
		t.Error("a page read from a forward cursor offered no way back")
	}
}

// A backward read arrives nearest-anchor-first and its count covers this page
// plus everything ahead, so both the order and the position need correcting.
func TestABackwardPageIsReReversedAndItsPositionCorrected(t *testing.T) {
	anchor := mustDecode(t, encode(t, paging.Before, "5"))
	// Fetched backwards: 4 and 3 are the page, 2 is the proof of a page behind.
	page, err := paging.Resolve(rows(4, 3, 2), 2, &anchor, &paging.Counts{Total: 9, Preceding: 4}, key)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got := numbers(page.Rows); !equalInts(got, []int{3, 4}) {
		t.Errorf("rows = %v, want [3 4] in display order", got)
	}
	if page.Counts.Preceding != 2 {
		t.Errorf("preceding = %d, want 4 minus the page's own 2", page.Counts.Preceding)
	}
	// Decoded, not merely asserted non-empty. The most plausible wrong
	// backward implementation anchors NextCursor on Rows[0] and PreviousCursor
	// on the last row — forgetting that TrimBackward has ALREADY re-reversed
	// the fetch — and a non-empty check passes it unchanged. The direction and
	// the key are the whole point of the asymmetry Resolve exists to own.
	if page.NextCursor == "" {
		t.Fatal("a backward page always has a page ahead: the one it came from")
	}
	next := mustDecode(t, page.NextCursor)
	if next.Direction != paging.After || next.Key[0] != "4" {
		t.Errorf("next cursor = %+v, want after row 4 (the page's LAST row in display order)", next)
	}
	if page.PreviousCursor == "" {
		t.Fatal("the fetch proved a page behind and no cursor was minted for it")
	}
	previous := mustDecode(t, page.PreviousCursor)
	if previous.Direction != paging.Before || previous.Key[0] != "3" {
		t.Errorf("previous cursor = %+v, want before row 3 (the page's FIRST row in display order)", previous)
	}
}

// The one behaviour `precedes` documents and nothing exercised: with counts
// present, the COUNT decides, not the cursor. Everything ahead of this page was
// deleted between the count query and the row query, so Preceding is 0 and
// there is genuinely nowhere to go back to — even though this page was read by
// following a forward cursor.
//
// Without this fixture `preceding > 0` and `cursor != nil` agree everywhere in
// the suite, so the rule could be swapped for the other and no test would say.
func TestACountedPageWithNothingAheadOffersNoWayBack(t *testing.T) {
	anchor := mustDecode(t, encode(t, paging.After, "7"))

	counted, err := paging.Resolve(rows(8, 9), 2, &anchor, &paging.Counts{Total: 2, Preceding: 0}, key)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if counted.PreviousCursor != "" {
		t.Error("nothing sorts ahead of this page and it offered a way back anyway")
	}

	// The same fetch and the same cursor, counts opted out: now the cursor is
	// the only evidence there is, and it says a page lies behind.
	uncounted, err := paging.Resolve(rows(8, 9), 2, &anchor, nil, key)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if uncounted.PreviousCursor == "" {
		t.Error("an uncounted page read from a cursor offered no way back")
	}
}

// Only reachable if rows were deleted between the count query and the row
// query. A negative position is a nonsense a caller would have to handle.
func TestAPositionCannotGoNegative(t *testing.T) {
	anchor := mustDecode(t, encode(t, paging.Before, "5"))
	page, err := paging.Resolve(rows(4, 3), 2, &anchor, &paging.Counts{Total: 2, Preceding: 1}, key)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if page.Counts.Preceding != 0 {
		t.Errorf("preceding = %d, want it clamped to 0", page.Counts.Preceding)
	}
}

// Resolve must not rewrite what the caller counted.
func TestResolveLeavesTheCallersCountsAlone(t *testing.T) {
	anchor := mustDecode(t, encode(t, paging.Before, "5"))
	counts := paging.Counts{Total: 9, Preceding: 4}
	if _, err := paging.Resolve(rows(4, 3), 2, &anchor, &counts, key); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if counts.Preceding != 4 {
		t.Errorf("the caller's counts were adjusted in place: %+v", counts)
	}
}

// A key anchored on no row would encode a cursor meaning "start again", which
// Encode refuses. Resolve must return that refusal rather than a page.
func TestAnEmptyKeyIsAnErrorNotACursor(t *testing.T) {
	_, err := paging.Resolve(rows(1, 2, 3), 2, nil, nil, func(row) []string { return nil })
	if err == nil {
		t.Fatal("an empty key produced a page")
	}
}

func encode(t *testing.T, d paging.Direction, k string) string {
	t.Helper()
	raw, err := paging.Encode(paging.Cursor{Direction: d, Key: []string{k}})
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	return raw
}
