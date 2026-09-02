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

// stubSearchServer serves a single fixed /search/issues response and records
// every request path it received. Recording ALL of them, not just the last, is
// what lets the tests below assert that the merged listing issues exactly one
// request — the property whose absence made this endpoint spend ~4s of the
// console's 5s budget walking 400 pull requests to find none (#513).
func stubSearchServer(t *testing.T, handle func(*http.Request) (int, any)) (*GitHub, func() []string) {
	t.Helper()
	var paths []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.String())
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
	return client, func() []string { return paths }
}

// searchItem builds one /search/issues result. Search does NOT return
// head.ref, which is why the console-raised check reads the body trailer
// instead of the branch name.
func searchHit(number int, mergedAt, body string) map[string]any {
	return map[string]any{
		"number":     number,
		"title":      fmt.Sprintf("chore(openbao): grant ns/app-%d", number),
		"html_url":   fmt.Sprintf("https://github.com/tesserix/tesserix-k8s/pull/%d", number),
		"body":       body,
		"created_at": "2026-08-20T09:00:00Z",
		"pull_request": map[string]any{
			"merged_at": mergedAt,
		},
	}
}

func searchResponse(items ...map[string]any) map[string]any {
	return map[string]any{"total_count": len(items), "items": items}
}

func mergedFromSearch(t *testing.T, resp any, since time.Time) []PullRequest {
	t.Helper()
	client, _ := stubSearchServer(t, func(r *http.Request) (int, any) { return http.StatusOK, resp })
	got, err := client.MergedPulls(context.Background(), since)
	if err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}
	return got
}

const consoleBody = "summary\n\nrequested-by: subject-9\nwhitelist: ns/app"

func windowStart() time.Time { return time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC) }

// The regression guard for #513. The endpoint was slow because it walked
// closed pull requests a page at a time and filtered by branch prefix in Go —
// four sequential round trips scanning 400 pull requests to find none. This
// pins the fix at the level that caused the problem: one request, and none of
// them to /pulls. A wall-clock assertion would be flaky and would not say WHY
// it got slow; a request count says exactly that.
func TestMergedPullsIssuesOneSearchRequestRatherThanWalkingPages(t *testing.T) {
	client, paths := stubSearchServer(t, func(r *http.Request) (int, any) {
		return http.StatusOK, searchResponse(searchHit(1, "2026-08-25T10:00:00Z", consoleBody))
	})

	if _, err := client.MergedPulls(context.Background(), windowStart()); err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}

	got := paths()
	if len(got) != 1 {
		t.Fatalf("issued %d requests (%v), want exactly 1", len(got), got)
	}
	if !strings.HasPrefix(got[0], "/search/issues") {
		t.Fatalf("request went to %q, want /search/issues", got[0])
	}
	for _, p := range got {
		if strings.Contains(p, "/pulls?") {
			t.Fatalf("fell back to a page walk: %q", p)
		}
	}
}

// The query must narrow server-side. Every qualifier here removes work the old
// implementation did in Go, and `merged:>=` is what replaces the page walk's
// `since` early return.
func TestMergedPullsNarrowsTheSearchServerSide(t *testing.T) {
	client, paths := stubSearchServer(t, func(r *http.Request) (int, any) {
		return http.StatusOK, searchResponse()
	})

	if _, err := client.MergedPulls(context.Background(), windowStart()); err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}

	query := paths()[0]
	for _, want := range []string{
		"repo%3Atesserix%2Ftesserix-k8s",
		"is%3Apr",
		"is%3Amerged",
		"base%3Amain",
		"head%3Asecret-service",
		"merged%3A%3E%3D2026-08-01",
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("query %q is missing %q", query, want)
		}
	}
}

// GitHub tokenises `head:`, so it narrows but does not guarantee: measured,
// `head:secret-service` and `head:secret-service/grant` return the same set.
// The console-raised check is therefore the body trailer, which only the
// console writes — a stronger marker than the branch name it replaces.
func TestMergedPullsRejectsAPullRequestTheConsoleDidNotRaise(t *testing.T) {
	got := mergedFromSearch(t, searchResponse(
		searchHit(1, "2026-08-25T10:00:00Z", consoleBody),
		searchHit(2, "2026-08-25T11:00:00Z", "a human wrote this one by hand"),
	), windowStart())

	if len(got) != 1 || got[0].Number != 1 {
		t.Fatalf("got %+v, want only pull 1", got)
	}
}

// `merged:>=` is day-granular, so a merge earlier on the boundary day comes
// back from GitHub and must still be excluded here.
func TestMergedPullsRejectsAMergeOlderThanSince(t *testing.T) {
	since := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	got := mergedFromSearch(t, searchResponse(
		searchHit(1, "2026-08-01T18:00:00Z", consoleBody),
		searchHit(2, "2026-08-01T06:00:00Z", consoleBody),
	), since)

	if len(got) != 1 || got[0].Number != 1 {
		t.Fatalf("got %+v, want only pull 1", got)
	}
}

func TestMergedPullsRejectsAnUnmergedResult(t *testing.T) {
	// is:merged should prevent this, but a null merged_at must never become a
	// "your request is live" notification if one slips through.
	got := mergedFromSearch(t, searchResponse(
		searchHit(1, "2026-08-25T10:00:00Z", consoleBody),
		map[string]any{
			"number": 2, "title": "t", "html_url": "https://example.com/2",
			"body": consoleBody, "created_at": "2026-08-20T09:00:00Z",
			"pull_request": map[string]any{"merged_at": nil},
		},
	), windowStart())

	if len(got) != 1 || got[0].Number != 1 {
		t.Fatalf("got %+v, want only pull 1", got)
	}
}

func TestMergedPullsCarriesRequesterAndMergedAt(t *testing.T) {
	got := mergedFromSearch(t, searchResponse(
		searchHit(7, "2026-08-25T10:00:00Z", consoleBody),
	), windowStart())

	if len(got) != 1 {
		t.Fatalf("got %d pulls, want 1", len(got))
	}
	if got[0].RequestedBy != "subject-9" {
		t.Fatalf("RequestedBy = %q, want subject-9", got[0].RequestedBy)
	}
	if !got[0].MergedAt.Equal(time.Date(2026, 8, 25, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("MergedAt = %v, want 2026-08-25T10:00:00Z", got[0].MergedAt)
	}
	if len(got[0].Targets) != 1 || got[0].Targets[0] != "ns/app" {
		t.Fatalf("Targets = %v, want [ns/app]", got[0].Targets)
	}
}

func TestMergedPullsSortsNewestFirst(t *testing.T) {
	got := mergedFromSearch(t, searchResponse(
		searchHit(1, "2026-08-20T10:00:00Z", consoleBody),
		searchHit(2, "2026-08-26T10:00:00Z", consoleBody),
		searchHit(3, "2026-08-23T10:00:00Z", consoleBody),
	), windowStart())

	if len(got) != 3 || got[0].Number != 2 || got[1].Number != 3 || got[2].Number != 1 {
		t.Fatalf("order = %v, want [2 3 1]", []int{got[0].Number, got[1].Number, got[2].Number})
	}
}

// The page walk errored rather than returning a quietly truncated list. One
// request cannot walk, but the same principle applies: if GitHub says there
// are more results than it returned, say so rather than silently dropping the
// remainder.
func TestMergedPullsReportsTruncationRatherThanReturningAShortList(t *testing.T) {
	client, _ := stubSearchServer(t, func(r *http.Request) (int, any) {
		return http.StatusOK, map[string]any{
			"total_count": 250,
			"items":       []map[string]any{searchHit(1, "2026-08-25T10:00:00Z", consoleBody)},
		}
	})

	got, err := client.MergedPulls(context.Background(), windowStart())
	if err == nil {
		t.Fatalf("returned %d pulls and no error, want an error naming the truncation", len(got))
	}
	if got != nil {
		t.Fatalf("returned %v alongside the error, want nil", got)
	}
	if !strings.Contains(err.Error(), "250") {
		t.Fatalf("error %q does not name how many results were found", err)
	}
}
