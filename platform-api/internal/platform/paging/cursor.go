// Package paging holds the platform API's pagination convention: an opaque
// keyset cursor and the trimming that turns a limit+1 fetch into a page.
// Kernel, not a module — every listing endpoint in the service uses it, and it
// depends on no module.
//
// # Keyset, because the console already decided
//
// #240 and #241 standardised the console on keyset cursors with honest totals.
// #269 is explicit that "the API should not disagree with its own UI", so this
// service pages the same way. The properties that matter are the ones the
// console's own codec documents and this one keeps:
//
//   - The cursor is OPAQUE and encoded, not a tuple the caller could assemble
//     from URL parameters it half-trusts.
//   - The direction lives INSIDE the cursor, not beside it as a second
//     parameter. A cursor is handled as one string — copied into a link,
//     bookmarked, reloaded — and a separate ?direction= is one copy-paste away
//     from being lost. A cursor whose direction went missing does not fail; it
//     renders the page on the wrong side of the anchor row and says nothing.
//   - A malformed cursor is REJECTED, never silently degraded to page one.
//     Degrading shows the caller something other than what they asked for
//     while reporting success.
//
// # Why the encoding differs from the console's
//
// apps/console/lib/db/keyset-cursor.ts encodes `direction|timestamp|uuid`.
// That works there because both of its surfaces sort on exactly one timestamp
// and one id. This service's first listing does not: the ticket queue orders
// by a status bucket, then a priority rank, then updated_at, then id — four
// components, one of which is derived. A two-field codec cannot express it,
// and widening the pipe format would need escaping rules, because a component
// this codec does not control may contain a pipe.
//
// So the key is a list and the encoding is JSON inside base64url. Both are
// invisible to the caller — the cursor is opaque in either format — and the
// contract the console established (opaque, self-describing direction,
// rejected when malformed) is unchanged.
//
// # What the second example added: counts, and where they stop
//
// This package began as the codec plus Page[T] — rows and HasMore, the honest
// result of a limit+1 fetch. Everything a listing needs BEYOND that (an
// SQL-counted total, an SQL-counted position, and the two edge cursors) lived
// in the tickets module, correctly, because a shape extracted from one example
// is a guess. §9's rule is that extractions happen on the second example, and
// the CRM queues module is it: every CRM listing reports the same two counts,
// and left alone it would have written a third page type.
//
// The seam chosen is a SECOND type — CountedPage[T], assembled by Resolve —
// rather than a wider Page[T]. counted.go argues that at length; the short
// version is that a listing which only wants "is there more" must not be made
// to run a COUNT query, and that HasMore and NextCursor mean different things
// on a backward read, so a struct holding both invites the wrong reading.
//
// What did NOT move is which columns a cursor's key is made of. The encoding
// is uniform across listings and belongs here; the key is an ORDER BY this
// package never sees — two of the ticket queue's four components are derived
// expressions — so the caller passes a Key function and the kernel does the
// rest.
package paging

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// Direction is which way a page lies relative to the row its cursor names, in
// the surface's own DISPLAY order.
//
// "after"/"before" rather than "asc"/"desc" or "next"/"prev", for the reason
// the console's codec records: this package cannot know how its caller sorts.
// What a cursor honestly knows is that the requested page lies after — or
// before — the row it names, and each caller resolves that against the order
// it alone declares.
type Direction string

const (
	After  Direction = "after"
	Before Direction = "before"
)

// ErrMalformedCursor is what every rejection unwraps to.
//
// One sentinel because every caller does the same thing with it — answers 400
// naming the parameter — and because the reasons a cursor is unreadable
// (invalid base64, wrong version, missing direction) are not distinctions a
// client can act on. They differ only in the log.
var ErrMalformedCursor = errors.New("malformed cursor")

// version is carried in the payload so a future change to the key's shape is a
// rejection rather than a misread.
//
// Without it, adding a fifth component to the ticket sort would leave old
// cursors — sitting in a bookmark or a browser's history — decoding into a
// four-element key that the new query binds positionally against different
// columns. That is a page silently rendered from the wrong anchor, which is
// the failure this whole package is written to avoid. A version turns it into
// a 400 the caller can retry from page one.
const version = 1

// Cursor is a decoded keyset position.
type Cursor struct {
	// Key is the value of every ORDER BY component for the anchor row, in
	// declaration order, rendered as text. Text rather than typed values
	// because the components are heterogeneous — a rank, a timestamp, a uuid —
	// and Postgres compares them correctly when they are cast back at the
	// parameter, which is where the column's own type is known.
	Key []string
	// Direction is the side of Key the requested page lies on.
	Direction Direction
}

type payload struct {
	Version   int       `json:"v"`
	Direction Direction `json:"d"`
	Key       []string  `json:"k"`
}

// Encode renders a cursor as the opaque string a client receives.
//
// base64url without padding: the value travels in a query parameter, and
// standard base64's `+` and `/` would need escaping that some clients get
// wrong and others do twice.
func Encode(c Cursor) (string, error) {
	if c.Direction != After && c.Direction != Before {
		return "", fmt.Errorf("encoding cursor: direction %q is neither after nor before", c.Direction)
	}
	if len(c.Key) == 0 {
		// An empty key anchors on nothing, so the page it produced would be
		// the first page regardless of direction — a cursor that lies about
		// being a position.
		return "", errors.New("encoding cursor: the key is empty")
	}
	body, err := json.Marshal(payload{Version: version, Direction: c.Direction, Key: c.Key})
	if err != nil {
		return "", fmt.Errorf("encoding cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

// Decode reads a cursor from a caller-supplied string.
//
// `want` is the number of components the caller's ORDER BY has. Checked here
// rather than left to the query, because binding a key of the wrong length
// positionally is the exact misread `version` exists to prevent — and a cursor
// minted by a different endpoint of this same service would pass every other
// check.
func Decode(raw string, want int) (Cursor, error) {
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return Cursor{}, fmt.Errorf("%w: not base64url (%s)", ErrMalformedCursor, err)
	}
	var decoded payload
	if err := json.Unmarshal(body, &decoded); err != nil {
		return Cursor{}, fmt.Errorf("%w: not the cursor payload (%s)", ErrMalformedCursor, err)
	}
	if decoded.Version != version {
		return Cursor{}, fmt.Errorf("%w: version %d, this service reads %d", ErrMalformedCursor, decoded.Version, version)
	}
	if decoded.Direction != After && decoded.Direction != Before {
		// Including the absent case. Defaulting a missing direction to "after"
		// would take a link built to page backwards and quietly serve the page
		// ahead instead.
		return Cursor{}, fmt.Errorf("%w: direction %q", ErrMalformedCursor, decoded.Direction)
	}
	if len(decoded.Key) != want {
		return Cursor{}, fmt.Errorf("%w: key has %d components, this listing sorts on %d",
			ErrMalformedCursor, len(decoded.Key), want)
	}
	return Cursor{Key: decoded.Key, Direction: decoded.Direction}, nil
}

// Page is a limit+1 fetch resolved into rows and the proof of another page.
type Page[T any] struct {
	Rows []T
	// HasMore is true when the fetch returned its proof row: another page
	// exists in the direction this one was read.
	HasMore bool
}

// TrimForward resolves a forward limit+1 fetch.
//
// A forward fetch is ordered the way the surface displays, so the rows arrive
// in display order and the extra row is the first of the NEXT page.
func TrimForward[T any](fetched []T, limit int) Page[T] {
	if len(fetched) > limit {
		return Page[T]{Rows: fetched[:limit], HasMore: true}
	}
	return Page[T]{Rows: fetched, HasMore: false}
}

// TrimBackward resolves a backward limit+1 fetch, in display order.
//
// A backward fetch flips the ORDER BY, so the driver returns the row NEAREST
// the anchor first — that is, the page's LAST row first, with everything after
// it running backwards. Two things follow, and both are easy to get wrong
// because a small fixture hides them:
//
//   - the proof row is at the END of the fetch (it is furthest from the anchor
//     and belongs to the page before this one), so the page is the first
//     `limit` rows exactly as in the forward case;
//   - the page must then be re-reversed. Skipping that renders the page upside
//     down while its counts, its range and both its cursors stay correct — a
//     defect visible nowhere except in the order of the rows themselves.
//
// The reversal is done on a copy. Reversing the driver's result set in place
// would be correct here and wrong the moment a caller kept a reference to it.
func TrimBackward[T any](fetched []T, limit int) Page[T] {
	page := Page[T]{Rows: fetched, HasMore: false}
	if len(fetched) > limit {
		page = Page[T]{Rows: fetched[:limit], HasMore: true}
	}
	reversed := make([]T, len(page.Rows))
	for i, row := range page.Rows {
		reversed[len(page.Rows)-1-i] = row
	}
	page.Rows = reversed
	return page
}
