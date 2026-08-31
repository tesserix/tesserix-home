package gitops_test

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

func TestPullsListsOnlyTheBranchesThisConsoleOpened(t *testing.T) {
	client, _ := stubGitHub(t, func(c *call) (int, any) {
		return http.StatusOK, []any{
			map[string]any{
				"number":     9,
				"title":      "chore(openbao): grant homechef/api",
				"html_url":   "https://github.com/tesserix/tesserix-k8s/pull/9",
				"created_at": "2026-08-14T06:00:00Z",
				"user":       map[string]any{"login": "tesserix-bot"},
				"head":       map[string]any{"ref": "secret-service/grant-homechef-api-1"},
			},
			map[string]any{
				"number":   10,
				"title":    "feat: something a human is doing",
				"html_url": "https://github.com/tesserix/tesserix-k8s/pull/10",
				"user":     map[string]any{"login": "sam123ben"},
				"head":     map[string]any{"ref": "feat/unrelated"},
			},
		}
	})

	pulls, err := client.Pulls(context.Background())
	if err != nil {
		t.Fatalf("Pulls: %v", err)
	}
	if len(pulls) != 1 {
		t.Fatalf("Pulls = %+v, want only the console's own branch", pulls)
	}
	var got gitops.PullRequest = pulls[0]
	if got.Number != 9 || got.Branch != "secret-service/grant-homechef-api-1" || got.Author != "tesserix-bot" {
		t.Fatalf("Pulls[0] = %+v, want pull 9 on its own branch", got)
	}
	if got.CreatedAt.IsZero() {
		t.Fatal("Pulls[0] has no creation time; the review queue is ordered by it")
	}
}

func TestPullReportsTheDiffAndItsApprovals(t *testing.T) {
	client, _ := stubGitHub(t, func(c *call) (int, any) {
		switch {
		case strings.HasSuffix(c.Path, "/files"):
			return http.StatusOK, []any{
				map[string]any{"filename": "charts/thirdparty/openbao/values.yaml", "additions": 3, "deletions": 0, "patch": "@@ -1 +1,3 @@"},
			}
		case strings.HasSuffix(c.Path, "/reviews"):
			return http.StatusOK, []any{
				map[string]any{"state": "APPROVED", "user": map[string]any{"login": "sam123ben"}},
				map[string]any{"state": "COMMENTED", "user": map[string]any{"login": "someone"}},
			}
		default:
			return http.StatusOK, map[string]any{
				"number":          9,
				"title":           "chore(openbao): grant homechef/api",
				"html_url":        "https://github.com/tesserix/tesserix-k8s/pull/9",
				"user":            map[string]any{"login": "tesserix-bot"},
				"head":            map[string]any{"ref": "secret-service/grant-homechef-api-1"},
				"mergeable_state": "clean",
			}
		}
	})

	got, err := client.Pull(context.Background(), 9)
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if got.Number != 9 || got.MergeableState != "clean" {
		t.Fatalf("Pull = %+v, want pull 9 in a clean state", got)
	}
	if len(got.Files) != 1 || got.Files[0].Patch != "@@ -1 +1,3 @@" {
		t.Fatalf("Pull files = %+v, want the diff an admin reviews", got.Files)
	}
	if len(got.Approvals) != 1 || got.Approvals[0] != "sam123ben" {
		t.Fatalf("Pull approvals = %+v, want only the approving reviewer", got.Approvals)
	}
}

func TestApproveNamesTheAdministratorWhoReviewed(t *testing.T) {
	client, seen := stubGitHub(t, func(c *call) (int, any) { return http.StatusOK, map[string]any{} })

	if err := client.Approve(context.Background(), 9, "samyak.rout@gmail.com"); err != nil {
		t.Fatalf("Approve: %v", err)
	}

	review := findCall(t, *seen, http.MethodPost, "/pulls/9/reviews")
	if review.Body["event"] != "APPROVE" {
		t.Fatalf("review event = %v, want APPROVE", review.Body["event"])
	}
	if body, _ := review.Body["body"].(string); !strings.Contains(body, "samyak.rout@gmail.com") {
		t.Fatalf("review body %q does not name the approving administrator", body)
	}
}

func TestMergeSquashesAndReportsTheCommit(t *testing.T) {
	client, seen := stubGitHub(t, func(c *call) (int, any) {
		return http.StatusOK, map[string]any{"merged": true, "sha": "merge-sha"}
	})

	sha, err := client.Merge(context.Background(), 9, "samyak.rout@gmail.com")
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if sha != "merge-sha" {
		t.Fatalf("Merge = %q, want the merge commit", sha)
	}

	merge := findCall(t, *seen, http.MethodPut, "/pulls/9/merge")
	if merge.Body["merge_method"] != "squash" {
		t.Fatalf("merge_method = %v, want squash", merge.Body["merge_method"])
	}
}

func TestMergeReportsARefusalRatherThanClaimingSuccess(t *testing.T) {
	client, _ := stubGitHub(t, func(c *call) (int, any) {
		return http.StatusMethodNotAllowed, map[string]any{"message": "Required status check is expected"}
	})

	if _, err := client.Merge(context.Background(), 9, "samyak.rout@gmail.com"); err == nil {
		t.Fatal("Merge succeeded against a protected branch, want the refusal reported")
	}
}

// The access screen shows an app's pending proposal beside its grant, so a pull
// request has to say which apps it covers in a form that survives a round trip
// through GitHub. The title is prose; the trailer is not.
func TestPullsReportsTheAppsEachProposalCovers(t *testing.T) {
	client, _ := stubGitHub(t, func(c *call) (int, any) {
		return http.StatusOK, []any{
			map[string]any{
				"number":     245,
				"title":      "chore(openbao): grant dwellm8/dwellm8-api and 1 more",
				"html_url":   "https://github.com/tesserix/tesserix-k8s/pull/245",
				"created_at": "2026-08-14T07:57:56Z",
				"user":       map[string]any{"login": "tesserix-bot"},
				"head":       map[string]any{"ref": "secret-service/grant-dwellm8-dwellm8-api-1"},
				"body":       "grant dwellm8/dwellm8-api\n\nRequested by sam@example.com.\n\nwhitelist: dwellm8/dwellm8-api, dwellm8/dwellm8-nats\n",
			},
		}
	})

	pulls, err := client.Pulls(context.Background())
	if err != nil {
		t.Fatalf("Pulls: %v", err)
	}
	want := []string{"dwellm8/dwellm8-api", "dwellm8/dwellm8-nats"}
	if len(pulls) != 1 || !slices.Equal(pulls[0].Targets, want) {
		t.Fatalf("Targets = %+v, want %v", pulls, want)
	}
}

// Rejecting closes the pull request and deletes its branch, so the console can
// propose the same grant again from a clean base rather than reusing a branch
// the administrator has already turned down.
func TestRejectClosesThePullRequestAndDeletesItsBranch(t *testing.T) {
	client, seen := stubGitHub(t, func(c *call) (int, any) {
		if strings.HasSuffix(c.Path, "/pulls/245") && c.Method == http.MethodGet {
			return http.StatusOK, map[string]any{
				"number": 245,
				"head":   map[string]any{"ref": "secret-service/grant-dwellm8-dwellm8-api-1"},
			}
		}
		return http.StatusOK, map[string]any{}
	})

	if err := client.Reject(context.Background(), 245, "sam@example.com", "wrong service account"); err != nil {
		t.Fatalf("Reject: %v", err)
	}

	closed := findCall(t, *seen, http.MethodPatch, "/pulls/245")
	if closed.Body["state"] != "closed" {
		t.Errorf("patch body = %+v, want the pull request closed", closed.Body)
	}
	comment := findCall(t, *seen, http.MethodPost, "/issues/245/comments")
	if body, _ := comment.Body["body"].(string); !strings.Contains(body, "wrong service account") {
		t.Errorf("comment = %q, want it to record why the change was rejected", body)
	}
	findCall(t, *seen, http.MethodDelete, "/git/refs/heads/secret-service/grant-dwellm8-dwellm8-api-1")
}

// openPulls builds one page of pull requests on this console's own branches.
func openPulls(from, count int) []any {
	page := make([]any, 0, count)
	for i := range count {
		number := from + i
		page = append(page, map[string]any{
			"number":     number,
			"title":      "chore(openbao): grant homechef/api",
			"html_url":   fmt.Sprintf("https://github.com/tesserix/tesserix-k8s/pull/%d", number),
			"created_at": "2026-08-14T06:00:00Z",
			"user":       map[string]any{"login": "tesserix-bot"},
			"head":       map[string]any{"ref": fmt.Sprintf("secret-service/grant-homechef-api-%d", number)},
		})
	}
	return page
}

func pageOf(query string) string {
	values, err := url.ParseQuery(query)
	if err != nil {
		return ""
	}
	return values.Get("page")
}

func pullPageRequests(seen []call) []string {
	pages := make([]string, 0, 2)
	for _, c := range seen {
		if c.Method == http.MethodGet && strings.HasSuffix(c.Path, "/pulls") {
			pages = append(pages, pageOf(c.Query))
		}
	}
	return pages
}

func TestPullsAsksOnceWhenTheFirstPageIsShort(t *testing.T) {
	client, seen := stubGitHub(t, func(c *call) (int, any) {
		return http.StatusOK, openPulls(1, 3)
	})

	pulls, err := client.Pulls(context.Background())
	if err != nil {
		t.Fatalf("Pulls: %v", err)
	}
	if len(pulls) != 3 {
		t.Fatalf("Pulls returned %d proposals, want 3", len(pulls))
	}
	if pages := pullPageRequests(*seen); len(pages) != 1 {
		t.Fatalf("asked for pages %v, want one request for a queue that fits on one page", pages)
	}
}

// A hundred open pull requests on tesserix-k8s is ordinary, and the queue used
// to stop dead at that line: the operator saw a shorter list with nothing to
// say it was short.
func TestPullsWalksEveryPageRatherThanTruncatingAtAHundred(t *testing.T) {
	client, seen := stubGitHub(t, func(c *call) (int, any) {
		switch pageOf(c.Query) {
		case "1":
			return http.StatusOK, openPulls(1, 100)
		case "2":
			return http.StatusOK, openPulls(101, 7)
		default:
			t.Errorf("Pulls asked for page %q after a short page", pageOf(c.Query))
			return http.StatusOK, []any{}
		}
	})

	pulls, err := client.Pulls(context.Background())
	if err != nil {
		t.Fatalf("Pulls: %v", err)
	}
	if len(pulls) != 107 {
		t.Fatalf("Pulls returned %d proposals, want all 107 across both pages", len(pulls))
	}
	if pages := pullPageRequests(*seen); len(pages) != 2 || pages[0] != "1" || pages[1] != "2" {
		t.Fatalf("asked for pages %v, want page 1 then page 2", pages)
	}
}

// The walk is bounded, and reaching the bound is reported. Returning whatever
// had been collected would reproduce the very failure this replaced: a short
// list that looks complete.
func TestPullsReportsTheBoundRatherThanReturningAShortList(t *testing.T) {
	client, seen := stubGitHub(t, func(c *call) (int, any) {
		return http.StatusOK, openPulls(1, 100)
	})

	pulls, err := client.Pulls(context.Background())
	if err == nil {
		t.Fatalf("Pulls returned %d proposals and no error, want the truncation reported", len(pulls))
	}
	if pulls != nil {
		t.Errorf("Pulls returned %d proposals alongside the error; a partial list reads as complete", len(pulls))
	}
	if !strings.Contains(err.Error(), "truncated") {
		t.Errorf("error = %v, want it to say the list would be truncated", err)
	}
	if pages := pullPageRequests(*seen); len(pages) > 50 {
		t.Fatalf("Pulls made %d requests before giving up; the loop is not bounded", len(pages))
	}
}
