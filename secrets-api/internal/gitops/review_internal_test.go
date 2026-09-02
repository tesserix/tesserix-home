package gitops

import (
	"context"
	"encoding/json"
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
