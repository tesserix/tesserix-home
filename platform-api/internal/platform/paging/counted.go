package paging

// Counts are the two numbers a listing reports about itself. Both are COUNTED
// IN SQL; neither is ever inferred from a cursor.
//
// A keyset cursor carries no position of its own — it names an anchor row, not
// an offset — so "how far into the result set is this page" cannot be
// recovered from it. That is why Preceding is a count and not arithmetic, and
// why this type is something a caller fills in from a query rather than
// something this package derives.
//
// # The count query and the row query run SEQUENTIALLY, not concurrently
//
// This type owns the pair, so the reasoning lives here rather than in whichever
// module happens to be first. The console runs its equivalent pair with
// Promise.all; this service does not, because the pool is capped at two
// connections (ADR-003 D2a) and a concurrent pair would take both for one
// request — turning the second concurrent listing into a wait for a connection
// rather than a wait for a query. Two round trips in series cost less than a
// listing that cannot start.
//
// # Preceding is best aggregated INTO the count query
//
// It is the same predicate over the same rows as Total, differing only by a
// FILTER clause, so a third query would pay a round trip to re-scan what the
// second already had in hand.
type Counts struct {
	// Total is every row matching the filter, ignoring the limit.
	Total int64
	// Preceding is how many matching rows sort ahead of this page; 0 on the
	// first page.
	//
	// For a BACKWARD read the natural SQL count covers this page plus
	// everything ahead of it — see Resolve, which subtracts the page's own
	// length. Pass what the query returned; do not pre-adjust it.
	Preceding int
}

// Cursors are a page's two edges, already encoded.
//
// Empty — not a cursor that resolves to nothing — when there is no such page.
// httpx.Meta drops both with omitempty, and an empty string there is the
// absence the wire wants; a minted cursor for a page that does not exist would
// be a promise a client would follow.
type Cursors struct {
	NextCursor     string
	PreviousCursor string
}

// Key renders one row's anchor: the value of every ORDER BY component, in
// declaration order, as text — exactly what Cursor.Key documents.
//
// This is the half of cursor assembly that does NOT belong in the kernel. The
// ENCODING lives here (Encode, Decode, the version, the length check) because
// it is the same for every listing and getting it wrong is invisible. WHICH
// columns go into a key is knowledge only the caller has: they are the columns
// of an ORDER BY this package never sees, and two of the ticket queue's four
// are derived expressions with no column to read them back from. So the caller
// supplies this function and the kernel supplies everything around it.
type Key[T any] func(T) []string

// CountedPage is a resolved page: its rows, its counts if it reports any, and
// its two cursors.
//
// # Why a second type rather than a richer Page[T]
//
// Page[T] is the honest result of a limit+1 fetch and nothing more: rows and
// the proof another page exists. Widening it with Total, Preceding and two
// cursors would put four fields on every caller of TrimForward, including the
// ones that never count anything, and would leave HasMore sitting beside
// NextCursor saying almost — but not exactly — the same thing. Almost is the
// problem: on a BACKWARD read HasMore proves a page BEHIND, while NextCursor
// is unconditionally set. A single struct carrying both invites a caller to
// read HasMore as "there is a next page", which is true forward and false
// backward, and which no test with a symmetric fixture would catch.
//
// So Page[T] stays what it is, CountedPage is what a listing endpoint returns,
// and Resolve is the one place the asymmetry above is reasoned about.
//
// # Why Counts is a POINTER and the rest is not
//
// Not every listing wants counts, and forcing a second COUNT query on a cheap
// "is there more" list would be a tax the kernel has no business levying. Nil
// is how a caller opts out, and it must be nil rather than a zeroed Counts,
// because zero is a legitimate answer: "no rows match your filter". That
// distinction is the one httpx.Meta spends pointers to keep — preceding_count
// and total are *int and *int64 there precisely so a genuine zero serialises
// and an absent count disappears. A kernel type that flattened them to plain
// ints would hand the module a zero it could not tell from an absence, and the
// module would then have to invent its own flag to decide whether to fill in
// Meta. The distinction is preserved from the query, through this type, to the
// JSON.
//
// Cursors is embedded by value because there is no third state: a page either
// has an edge cursor or does not, and empty already says so.
//
// # Why a module still names its own page type
//
// §2 keeps resources domain-shaped, and a repository returning `Tickets`
// rather than `Rows` reads better at its call sites. A module embeds Counts
// and Cursors into its own struct, so the fields are the kernel's and no count
// is recomputed or renamed on the way through. What the kernel takes over is
// the DERIVATION — the backward Preceding adjustment, the next/previous
// asymmetry, and which edge row anchors which cursor. That is the part a
// second module would have copied and the part where a copy would be subtly
// wrong.
type CountedPage[T any] struct {
	Rows []T
	// Counts is non-nil exactly when the caller passed counts to Resolve.
	Counts *Counts
	Cursors
}

// Resolve turns a limit+1 fetch, its cursor and its counts into a page.
//
// `cursor` is the decoded cursor the page was read from, or nil for a first
// page. `counts` is what the count query returned, or nil to report none.
// `key` renders a row's anchor. A key that came back empty is an error, not a
// cursor: Encode rejects it, and Resolve returns that rejection rather than a
// page carrying a cursor anchored on no row.
//
// Everything below is a consequence of one fact: a backward read runs with a
// flipped ORDER BY, so almost every asymmetry in this function traces back to
// the fetch having arrived nearest-anchor-first.
func Resolve[T any](fetched []T, limit int, cursor *Cursor, counts *Counts, key Key[T]) (CountedPage[T], error) {
	backwards := cursor != nil && cursor.Direction == Before

	page := TrimForward(fetched, limit)
	if backwards {
		page = TrimBackward(fetched, limit)
	}

	var resolved *Counts
	if counts != nil {
		// Copied rather than adjusted in place: the caller still holds the
		// value it counted, and a function that quietly rewrote it would make
		// a second call on the same Counts wrong.
		c := *counts
		if backwards {
			// The backward count covered this page plus everything ahead of
			// it, because the anchor row sorts after this page and the count's
			// predicate could only exclude the anchor, not the page.
			c.Preceding -= len(page.Rows)
			if c.Preceding < 0 {
				// Only reachable if rows were deleted between the count query
				// and the row query. Clamped rather than reported: a negative
				// position is a nonsense a caller would have to handle, and
				// the honest answer to "how far in are we" after a concurrent
				// delete is "near the start".
				c.Preceding = 0
			}
		}
		resolved = &c
	}

	result := CountedPage[T]{Rows: page.Rows, Counts: resolved}
	if len(page.Rows) == 0 {
		// No edges, so no cursors. An empty page that offered one would
		// promise a neighbour it cannot name a row for.
		return result, nil
	}

	// Forward: another page exists iff the fetch returned its proof row, and a
	// page BEHIND exists iff something sorts ahead of this one.
	//
	// Backward: what the fetch proved is a page further BACK, and the forward
	// promise comes from the fact that we arrived here from somewhere — there
	// is by construction a page ahead, the one whose cursor we followed.
	hasNext, hasPrevious := page.HasMore, precedes(cursor, resolved)
	if backwards {
		hasNext, hasPrevious = true, page.HasMore
	}

	var err error
	if hasNext {
		result.NextCursor, err = Encode(Cursor{Direction: After, Key: key(page.Rows[len(page.Rows)-1])})
		if err != nil {
			return CountedPage[T]{}, err
		}
	}
	if hasPrevious {
		result.PreviousCursor, err = Encode(Cursor{Direction: Before, Key: key(page.Rows[0])})
		if err != nil {
			return CountedPage[T]{}, err
		}
	}
	return result, nil
}

// precedes answers "is there a page behind this one" for a FORWARD read, from
// whichever evidence the caller has.
//
// With counts, the count is the answer and it is the better one: after a
// concurrent delete of everything ahead, Preceding is 0 and there genuinely is
// no page to go back to, even though this read followed a cursor.
//
// Without counts, the cursor's existence is the only evidence there is, and it
// is very nearly as good: a forward page read from a cursor has at least the
// anchor row ahead of it, since the anchor is the last row of the page before.
// The two rules agree everywhere except that concurrent delete, and a listing
// that opted out of counting has already accepted answers of this quality.
func precedes(cursor *Cursor, counts *Counts) bool {
	if counts != nil {
		return counts.Preceding > 0
	}
	return cursor != nil
}
