package gitops

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// These tests exercise trailerValue, requesterTrailer and pullResource, which
// are unexported, so they live in package gitops rather than gitops_test
// alongside review_test.go.

func TestTrailerValueReadsRequester(t *testing.T) {
	body := "summary\n\nRequested by 291837.\n\nrequested-by: 291837\nwhitelist: ns/app"
	if got := trailerValue(body, requesterTrailer); got != "291837" {
		t.Fatalf("requester = %q, want %q", got, "291837")
	}
}

func TestTrailerValueAbsentIsEmpty(t *testing.T) {
	// A proposal opened before this shipped carries no trailer. Empty is the
	// only safe answer: it must match no recipient downstream.
	if got := trailerValue("summary\n\nwhitelist: ns/app", requesterTrailer); got != "" {
		t.Fatalf("requester = %q, want empty", got)
	}
}

func TestToPullRequestCarriesRequester(t *testing.T) {
	p := pullResource{Body: "s\n\nrequested-by: subject-9\nwhitelist: ns/app"}
	if got := p.toPullRequest().RequestedBy; got != "subject-9" {
		t.Fatalf("RequestedBy = %q, want %q", got, "subject-9")
	}
}

func TestParseTargetsStillWorks(t *testing.T) {
	// The generalisation must not disturb the existing trailer.
	got := parseTargets("s\n\nrequested-by: x\nwhitelist: ns/a, ns/b")
	if len(got) != 2 || got[0] != "ns/a" || got[1] != "ns/b" {
		t.Fatalf("targets = %v, want [ns/a ns/b]", got)
	}
}

// stubMergedPullsServer serves a single fixed /pulls response and records the
// last request path+query it received. It mirrors gitops_test's stubGitHub,
// but lives here because MergedPulls' tests construct pullResource-shaped
// stub bodies and rely on unexported constants (pullPageSize) that
// gitops_test cannot see.
func stubMergedPullsServer(t *testing.T, handle func(*http.Request) (int, any)) (*GitHub, func() string) {
	t.Helper()
	var lastPath string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastPath = r.URL.String()
		status, body := handle(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)

	client := NewGitHub(GitHubConfig{
		BaseURL: srv.URL,
		Owner:   "tesserix",
		Repo:    "tesserix-k8s",
		Branch:  "main",
		Token:   "test-token",
	})
	return client, func() string { return lastPath }
}

func mergedPullsFromStub(t *testing.T, stub []map[string]any, since time.Time) []PullRequest {
	t.Helper()
	client, _ := stubMergedPullsServer(t, func(r *http.Request) (int, any) {
		return http.StatusOK, stub
	})

	got, err := client.MergedPulls(context.Background(), since)
	if err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}
	return got
}

func capturedPathFromStub(t *testing.T) string {
	t.Helper()
	client, path := stubMergedPullsServer(t, func(r *http.Request) (int, any) {
		return http.StatusOK, []map[string]any{}
	})

	if _, err := client.MergedPulls(context.Background(), time.Now()); err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}
	return path()
}

func TestMergedPullsRejectsClosedButUnmerged(t *testing.T) {
	// Two closed pull requests on secret-service branches; only one merged.
	// A rejected proposal must never produce a "your request is live" event.
	stub := []map[string]any{
		{"number": 1, "head": map[string]any{"ref": "secret-service/a"}, "merged_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z", "body": "requested-by: s1"},
		{"number": 2, "head": map[string]any{"ref": "secret-service/b"}, "merged_at": nil, "updated_at": "2026-09-01T10:00:00Z", "body": "requested-by: s2"},
	}
	got := mergedPullsFromStub(t, stub, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
	if len(got) != 1 || got[0].Number != 1 {
		t.Fatalf("got %+v, want only pull 1", got)
	}
}

func TestMergedPullsRejectsForeignBranches(t *testing.T) {
	// A human's own merged pull request against the same base is none of the
	// console's business, exactly as Pulls' branch filter already decides.
	stub := []map[string]any{
		{"number": 3, "head": map[string]any{"ref": "chore/tidy"}, "merged_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z", "body": ""},
	}
	if got := mergedPullsFromStub(t, stub, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)); len(got) != 0 {
		t.Fatalf("got %+v, want none", got)
	}
}

func TestMergedPullsStopsAtSince(t *testing.T) {
	// The walk is bounded by time, not by a page count: closed pull requests
	// accumulate forever, so a page bound would silently start missing recent
	// merges as history grows.
	stub := []map[string]any{
		{"number": 4, "head": map[string]any{"ref": "secret-service/a"}, "merged_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z", "body": "requested-by: s1"},
		{"number": 5, "head": map[string]any{"ref": "secret-service/b"}, "merged_at": "2026-01-01T10:00:00Z", "updated_at": "2026-01-01T10:00:00Z", "body": "requested-by: s2"},
	}
	got := mergedPullsFromStub(t, stub, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
	if len(got) != 1 || got[0].Number != 4 {
		t.Fatalf("got %+v, want only pull 4", got)
	}
}

// TestMergedPullsStopsRequestingPagesOnceItCrossesSince is the test that
// actually carries this task's central claim: the walk is bounded by
// `since`, not by page count. TestMergedPullsStopsAtSince above serves only
// two items, so it always exits through the "short page" branch and never
// reaches the `since` early-return at all — deleting that branch would not
// fail it. Here the stub serves a FULL page (pullPageSize items), some
// updated before `since` and some after, so only the early-return can stop
// the walk short of a second page. Both the returned set and the request
// count are asserted: the count is what tells "stopped early because of
// since" apart from "ran out of pages by coincidence".
func TestMergedPullsStopsRequestingPagesOnceItCrossesSince(t *testing.T) {
	since := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

	const qualifying = 3
	batch := make([]map[string]any, pullPageSize)
	for i := range batch {
		// GitHub serves this page sorted by updated, newest first, so the
		// qualifying (after `since`) items lead and the rest trail behind
		// the point where the walk must stop.
		updatedAt, mergedAt := "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z"
		if i < qualifying {
			updatedAt, mergedAt = "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z"
		}
		batch[i] = map[string]any{
			"number":     i + 1,
			"head":       map[string]any{"ref": "secret-service/a"},
			"merged_at":  mergedAt,
			"updated_at": updatedAt,
			"body":       fmt.Sprintf("requested-by: s%d", i+1),
		}
	}

	requests := 0
	client, _ := stubMergedPullsServer(t, func(r *http.Request) (int, any) {
		requests++
		return http.StatusOK, batch
	})

	got, err := client.MergedPulls(context.Background(), since)
	if err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}
	if len(got) != qualifying {
		t.Fatalf("got %d pulls, want %d", len(got), qualifying)
	}
	if requests != 1 {
		t.Fatalf("made %d requests, want 1 — the walk should stop once it crosses `since`, not because a page ran short", requests)
	}
}

func TestMergedPullsCarriesRequesterAndMergedAt(t *testing.T) {
	stub := []map[string]any{
		{"number": 6, "head": map[string]any{"ref": "secret-service/a"}, "merged_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z", "body": "requested-by: subject-9\nwhitelist: ns/app"},
	}
	got := mergedPullsFromStub(t, stub, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
	if len(got) != 1 {
		t.Fatalf("got %d pulls, want 1", len(got))
	}
	if got[0].RequestedBy != "subject-9" {
		t.Fatalf("RequestedBy = %q, want subject-9", got[0].RequestedBy)
	}
	if !got[0].MergedAt.Equal(time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("MergedAt = %v, want 2026-09-01T10:00:00Z", got[0].MergedAt)
	}
}

// TestMergedPullsWalksEveryPageRatherThanReturningOnlyTheLast mirrors
// TestPullsWalksEveryPageRatherThanTruncatingAtAHundred in review_test.go.
// Every other MergedPulls test either serves a short page (exits on page 1),
// stops at page 1 via `since`, or serves pullPageSize full pages until the
// bound error fires (which discards `out` entirely) — none of them would
// notice `out := make(...)` moved inside the page loop, which drops every
// page but the last. Here both pages are served in full and both are within
// `since`, so only walking every page and accumulating across them produces
// the right count.
func TestMergedPullsWalksEveryPageRatherThanReturningOnlyTheLast(t *testing.T) {
	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	firstPage := make([]map[string]any, pullPageSize)
	for i := range firstPage {
		firstPage[i] = map[string]any{
			"number":     i + 1,
			"head":       map[string]any{"ref": "secret-service/a"},
			"merged_at":  "2026-09-01T10:00:00Z",
			"updated_at": "2026-09-01T10:00:00Z",
			"body":       fmt.Sprintf("requested-by: s%d", i+1),
		}
	}
	const secondPageCount = 7
	secondPage := make([]map[string]any, secondPageCount)
	for i := range secondPage {
		secondPage[i] = map[string]any{
			"number":     pullPageSize + i + 1,
			"head":       map[string]any{"ref": "secret-service/b"},
			"merged_at":  "2026-08-01T10:00:00Z",
			"updated_at": "2026-08-01T10:00:00Z",
			"body":       fmt.Sprintf("requested-by: t%d", i+1),
		}
	}

	client, _ := stubMergedPullsServer(t, func(r *http.Request) (int, any) {
		switch r.URL.Query().Get("page") {
		case "1":
			return http.StatusOK, firstPage
		case "2":
			return http.StatusOK, secondPage
		default:
			t.Errorf("MergedPulls asked for page %q after a short page", r.URL.Query().Get("page"))
			return http.StatusOK, []map[string]any{}
		}
	})

	got, err := client.MergedPulls(context.Background(), since)
	if err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}
	if want := pullPageSize + secondPageCount; len(got) != want {
		t.Fatalf("MergedPulls returned %d pulls, want all %d across both pages", len(got), want)
	}

	byNumber := make(map[int]bool, len(got))
	for _, p := range got {
		byNumber[p.Number] = true
	}
	if !byNumber[1] {
		t.Error("missing pull 1 from the first page")
	}
	if !byNumber[pullPageSize+1] {
		t.Errorf("missing pull %d from the second page", pullPageSize+1)
	}
}

func TestMergedPullsRequestsClosedStateSortedByUpdated(t *testing.T) {
	// Asserts the query itself: state=open would return nothing merged, and an
	// unsorted walk cannot use `since` as its bound.
	path := capturedPathFromStub(t)
	for _, want := range []string{"state=closed", "sort=updated", "direction=desc"} {
		if !strings.Contains(path, want) {
			t.Fatalf("path %q missing %q", path, want)
		}
	}
}

// TestMergedPullsReportsTheBoundRatherThanReturningAShortList proves the walk
// cannot loop forever: an upstream that keeps answering full pages of pull
// requests all updated after `since` must produce an error, not a silently
// truncated list. In ordinary operation `since` stops the walk long before
// this; this test exists only to prove the backstop against a misbehaving
// upstream actually fires, and fires loudly.
func TestMergedPullsReportsTheBoundRatherThanReturningAShortList(t *testing.T) {
	client, _ := stubMergedPullsServer(t, func(r *http.Request) (int, any) {
		batch := make([]map[string]any, pullPageSize)
		for i := range batch {
			batch[i] = map[string]any{
				"number":     i + 1,
				"head":       map[string]any{"ref": "secret-service/a"},
				"merged_at":  "2026-09-01T10:00:00Z",
				"updated_at": "2026-09-01T10:00:00Z",
				"body":       "requested-by: s1",
			}
		}
		return http.StatusOK, batch
	})

	got, err := client.MergedPulls(context.Background(), time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC))
	if err == nil {
		t.Fatalf("MergedPulls returned %d pulls and no error, want the truncation reported", len(got))
	}
	if got != nil {
		t.Errorf("MergedPulls returned %d pulls alongside the error; a partial list reads as complete", len(got))
	}
	if !strings.Contains(err.Error(), "truncated") {
		t.Errorf("error = %v, want it to say the list would be truncated", err)
	}
}
