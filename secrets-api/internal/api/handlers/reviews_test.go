package handlers_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/handlers"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

type stubReviewer struct {
	pulls    []gitops.PullRequest
	detail   gitops.PullDetail
	approved int
	merged   int
	rejected int
	reason   string
	actor    string
	err      error
}

func (s *stubReviewer) Pulls(context.Context) ([]gitops.PullRequest, error) {
	return s.pulls, s.err
}

func (s *stubReviewer) Pull(_ context.Context, number int) (gitops.PullDetail, error) {
	return s.detail, s.err
}

func (s *stubReviewer) Approve(_ context.Context, number int, actor string) error {
	s.approved, s.actor = number, actor
	return s.err
}

func (s *stubReviewer) Merge(_ context.Context, number int, actor string) (string, error) {
	s.merged, s.actor = number, actor
	return "merge-sha", s.err
}

func (s *stubReviewer) Reject(_ context.Context, number int, actor, reason string) error {
	s.rejected, s.actor, s.reason = number, actor, reason
	return s.err
}

func serveReview(t *testing.T, r handlers.Reviewer, method, path string) *httptest.ResponseRecorder {
	return serveReviewBody(t, r, method, path, "")
}

func serveReviewBody(t *testing.T, r handlers.Reviewer, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)

	engine := gin.New()
	handlers.NewReviews(r, audit.New(io.Discard)).Register(engine, engine)

	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

func TestReviewsListsTheOpenProposals(t *testing.T) {
	r := &stubReviewer{pulls: []gitops.PullRequest{{Number: 9, Title: "chore(openbao): grant homechef/api"}}}

	rec := serveReview(t, r, http.MethodGet, "/api/reviews")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}

	var body struct {
		Pulls []gitops.PullRequest `json:"pulls"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Pulls) != 1 || body.Pulls[0].Number != 9 {
		t.Fatalf("pulls = %+v, want the one open proposal", body.Pulls)
	}
}

func TestReviewShowsTheDiffAnAdministratorApproves(t *testing.T) {
	r := &stubReviewer{detail: gitops.PullDetail{
		PullRequest: gitops.PullRequest{Number: 9},
		Files:       []gitops.ChangedFile{{Filename: "values.yaml", Patch: "@@"}},
	}}

	rec := serveReview(t, r, http.MethodGet, "/api/reviews/9")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "values.yaml") {
		t.Fatalf("body = %s, want the changed file", rec.Body)
	}
}

func TestApproveAndMergeReachTheRepository(t *testing.T) {
	r := &stubReviewer{}

	if rec := serveReview(t, r, http.MethodPost, "/api/reviews/9/approve"); rec.Code != http.StatusOK {
		t.Fatalf("approve status = %d, body %s", rec.Code, rec.Body)
	}
	if r.approved != 9 {
		t.Fatalf("approved pull %d, want 9", r.approved)
	}

	rec := serveReview(t, r, http.MethodPost, "/api/reviews/9/merge")
	if rec.Code != http.StatusOK {
		t.Fatalf("merge status = %d, body %s", rec.Code, rec.Body)
	}
	if r.merged != 9 || !strings.Contains(rec.Body.String(), "merge-sha") {
		t.Fatalf("merged pull %d, body %s", r.merged, rec.Body)
	}
}

// GitHub refuses a self-approval and refuses a merge that protection blocks.
// Either way the console must say so rather than report success.
func TestReviewReportsGitHubsRefusal(t *testing.T) {
	r := &stubReviewer{err: errors.New("gitops: Required status check is expected")}

	rec := serveReview(t, r, http.MethodPost, "/api/reviews/9/merge")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 when GitHub refuses", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Required status check") {
		t.Fatalf("body = %s, want GitHub's reason", rec.Body)
	}
}

func TestReviewsRejectANonNumericPull(t *testing.T) {
	if rec := serveReview(t, &stubReviewer{}, http.MethodGet, "/api/reviews/nine"); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a pull number that is not a number", rec.Code)
	}
}

func TestReviewsReportThatGitOpsIsNotConfigured(t *testing.T) {
	if rec := serveReview(t, nil, http.MethodGet, "/api/reviews"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 without a configured repository", rec.Code)
	}
}

func TestRejectClosesTheProposalWithItsReason(t *testing.T) {
	r := &stubReviewer{}

	rec := serveReviewBody(t, r, http.MethodPost, "/api/reviews/9/reject", `{"reason":"wrong service account"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject = %d %s, want 200", rec.Code, rec.Body)
	}
	if r.rejected != 9 || r.reason != "wrong service account" {
		t.Fatalf("rejected pull %d for %q, want 9 with the administrator's reason", r.rejected, r.reason)
	}
}

func TestRejectReportsGitHubsRefusal(t *testing.T) {
	r := &stubReviewer{err: errors.New("gitops: branch is protected")}

	if rec := serveReviewBody(t, r, http.MethodPost, "/api/reviews/9/reject", `{}`); rec.Code != http.StatusBadGateway {
		t.Fatalf("reject = %d, want the refusal reported", rec.Code)
	}
}
