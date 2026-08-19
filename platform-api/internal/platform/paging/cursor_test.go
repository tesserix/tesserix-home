package paging_test

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
)

func TestACursorSurvivesARoundTrip(t *testing.T) {
	want := paging.Cursor{
		Key:       []string{"0", "1", "2026-08-19T09:41:02.5Z", "3f2a1c94-0000-4000-8000-000000000001"},
		Direction: paging.After,
	}

	encoded, err := paging.Encode(want)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := paging.Decode(encoded, len(want.Key))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !slices.Equal(got.Key, want.Key) || got.Direction != want.Direction {
		t.Errorf("round trip = %+v, want %+v", got, want)
	}
}

func TestTheDirectionTravelsInsideTheCursor(t *testing.T) {
	// The property the console's codec documents at length: a direction
	// carried beside the cursor is one copy-paste away from being lost, and a
	// cursor whose direction went missing does not fail — it renders the page
	// on the wrong side of the anchor and says nothing.
	forward, _ := paging.Encode(paging.Cursor{Key: []string{"a"}, Direction: paging.After})
	backward, _ := paging.Encode(paging.Cursor{Key: []string{"a"}, Direction: paging.Before})

	if forward == backward {
		t.Fatal("two cursors differing only in direction encoded identically")
	}
	back, err := paging.Decode(backward, 1)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if back.Direction != paging.Before {
		t.Errorf("direction = %q, want before", back.Direction)
	}
}

func TestACursorIsURLSafe(t *testing.T) {
	// It travels in a query parameter. Standard base64's + and / would need
	// escaping that some clients get wrong and others apply twice.
	encoded, err := paging.Encode(paging.Cursor{
		Key:       []string{strings.Repeat("\xff\xfe", 8)},
		Direction: paging.After,
	})
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if strings.ContainsAny(encoded, "+/=") {
		t.Errorf("cursor %q contains a character that must be percent-encoded in a query string", encoded)
	}
}

func TestAComponentContainingTheConsolesSeparatorSurvives(t *testing.T) {
	// The concrete reason this codec is not the console's pipe format. Its two
	// components are a timestamp and a uuid, neither of which can contain a
	// pipe; this service's sort components are not so constrained, and a
	// separator-based encoding would silently split one component into two.
	want := []string{"a|b", "c||d", "\\|"}

	encoded, err := paging.Encode(paging.Cursor{Key: want, Direction: paging.After})
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := paging.Decode(encoded, len(want))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !slices.Equal(got.Key, want) {
		t.Errorf("key = %q, want %q", got.Key, want)
	}
}

func TestGarbageIsRejectedRatherThanDegradedToPageOne(t *testing.T) {
	// The single most important property here. Degrading shows the caller a
	// different page from the one the URL asked for while reporting success.
	for _, raw := range []string{
		"",
		"not-base64!!",
		base64.RawURLEncoding.EncodeToString([]byte("not json")),
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":1}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"d":"sideways","k":["a"]}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"k":["a"]}`)),
	} {
		got, err := paging.Decode(raw, 1)
		if err == nil {
			t.Errorf("Decode(%q) = %+v, nil error — want a rejection", raw, got)
			continue
		}
		if !errors.Is(err, paging.ErrMalformedCursor) {
			t.Errorf("Decode(%q) error does not unwrap to ErrMalformedCursor: %v", raw, err)
		}
	}
}

func TestACursorFromAnotherVersionIsRejected(t *testing.T) {
	// A cursor sitting in a bookmark, minted before a sort component was
	// added. Without the version it would decode into a key the new query
	// binds positionally against different columns — a page rendered from the
	// wrong anchor, reported as a success.
	stale := base64.RawURLEncoding.EncodeToString([]byte(`{"v":0,"d":"after","k":["a"]}`))

	if _, err := paging.Decode(stale, 1); !errors.Is(err, paging.ErrMalformedCursor) {
		t.Errorf("a cursor from another version was accepted: %v", err)
	}
}

func TestAKeyOfTheWrongLengthIsRejected(t *testing.T) {
	// A cursor minted by a different listing on this same service passes every
	// other check — same version, valid direction, real base64 — and would
	// bind the wrong number of parameters.
	fromAnotherListing, _ := paging.Encode(paging.Cursor{
		Key:       []string{"2026-08-19T09:41:02Z", "3f2a1c94-0000-4000-8000-000000000001"},
		Direction: paging.After,
	})

	if _, err := paging.Decode(fromAnotherListing, 4); !errors.Is(err, paging.ErrMalformedCursor) {
		t.Errorf("a two-component cursor was accepted by a four-component listing: %v", err)
	}
}

func TestEncodeRefusesToMintACursorThatIsNotAPosition(t *testing.T) {
	// An empty key anchors on nothing, so whatever page it produced would be
	// the first page regardless of direction.
	if _, err := paging.Encode(paging.Cursor{Direction: paging.After}); err == nil {
		t.Error("Encode accepted an empty key")
	}
	if _, err := paging.Encode(paging.Cursor{Key: []string{"a"}, Direction: "sideways"}); err == nil {
		t.Error("Encode accepted a direction that is neither after nor before")
	}
}

func TestTheEncodingIsOpaqueButNotSecret(t *testing.T) {
	// Recorded so nobody later mistakes base64 for protection and puts
	// something confidential in a sort key. It is an encoding, not a cipher.
	encoded, _ := paging.Encode(paging.Cursor{Key: []string{"visible"}, Direction: paging.After})
	body, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !strings.Contains(string(body), "visible") {
		t.Error("this test's premise is wrong; re-read it before changing the codec")
	}
}

func TestTrimForwardKeepsDisplayOrderAndReportsMore(t *testing.T) {
	page := paging.TrimForward([]int{1, 2, 3, 4}, 3)

	if !page.HasMore {
		t.Error("a limit+1 fetch that returned the proof row must report more")
	}
	if !slices.Equal(page.Rows, []int{1, 2, 3}) {
		t.Errorf("rows = %v, want the first 3 in display order", page.Rows)
	}
}

func TestTrimForwardOnAShortFetchPromisesNothing(t *testing.T) {
	page := paging.TrimForward([]int{1, 2}, 3)

	if page.HasMore {
		t.Error("a fetch shorter than the limit cannot prove another page exists")
	}
	if !slices.Equal(page.Rows, []int{1, 2}) {
		t.Errorf("rows = %v", page.Rows)
	}
}

func TestTrimForwardOnAnExactlyFullFetchPromisesNothing(t *testing.T) {
	// The boundary the +1 exists for. Without it, a final page that happens to
	// be exactly `limit` long would advertise a next page that renders empty.
	page := paging.TrimForward([]int{1, 2, 3}, 3)

	if page.HasMore {
		t.Error("a fetch of exactly limit rows returned no proof row and must not promise more")
	}
}

func TestTrimBackwardReReversesIntoDisplayOrder(t *testing.T) {
	// The defect this guards is invisible in the counts, the range and both
	// cursors — it shows up only in the order of the rows. A backward fetch
	// arrives nearest-the-anchor first, i.e. the page's LAST row first.
	page := paging.TrimBackward([]int{30, 20, 10, 5}, 3)

	if !page.HasMore {
		t.Error("the proof row was present and must be reported")
	}
	if !slices.Equal(page.Rows, []int{10, 20, 30}) {
		t.Errorf("rows = %v, want them re-reversed into display order", page.Rows)
	}
}

func TestTrimBackwardDropsTheProofRowFromTheFarEnd(t *testing.T) {
	// Stated separately because it is the half that looks wrong: the proof row
	// is furthest from the anchor, so it is at the END of the fetch — and yet
	// the page is still the FIRST `limit` rows, exactly as forward.
	page := paging.TrimBackward([]int{30, 20, 10, 5}, 3)

	if slices.Contains(page.Rows, 5) {
		t.Errorf("the proof row survived into the page: %v", page.Rows)
	}
}

func TestTrimBackwardDoesNotMutateTheCallersSlice(t *testing.T) {
	// Reversing in place would be correct here and wrong the moment a caller
	// kept a reference to the driver's result set.
	fetched := []int{30, 20, 10}
	paging.TrimBackward(fetched, 3)

	if !slices.Equal(fetched, []int{30, 20, 10}) {
		t.Errorf("the input was reversed in place: %v", fetched)
	}
}

func TestTrimmingAnEmptyFetch(t *testing.T) {
	for name, page := range map[string]paging.Page[int]{
		"forward":  paging.TrimForward([]int{}, 3),
		"backward": paging.TrimBackward([]int{}, 3),
	} {
		if page.HasMore {
			t.Errorf("%s: an empty fetch promised another page", name)
		}
		if len(page.Rows) != 0 {
			t.Errorf("%s: rows = %v, want none", name, page.Rows)
		}
	}
}
