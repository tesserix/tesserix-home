package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/handlers"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

type stubProposer struct {
	seen []gitops.Change
	url  string
	err  error
}

func (s *stubProposer) ProposeAll(_ context.Context, changes []gitops.Change) (string, error) {
	s.seen = changes
	return s.url, s.err
}

func (s *stubProposer) first() gitops.Change {
	if len(s.seen) == 0 {
		return gitops.Change{}
	}
	return s.seen[0]
}

func serve(t *testing.T, p handlers.Proposer, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec, _ := serveAudited(t, p, method, path, body)
	return rec
}

// serveAudited also returns the audit trail the request wrote, for the cases
// where what was recorded is the thing under test.
func serveAudited(t *testing.T, p handlers.Proposer, method, path, body string) (*httptest.ResponseRecorder, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	var trail bytes.Buffer
	r := gin.New()
	handlers.NewWhitelist(p, audit.New(&trail)).Register(r)

	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec, trail.String()
}

func TestProposeReturnsThePullRequestURL(t *testing.T) {
	p := &stubProposer{url: "https://github.com/tesserix/tesserix-k8s/pull/12"}

	rec := serve(t, p, http.MethodPost, "/api/access/whitelist",
		`{"namespace":"homechef","apps":[{"name":"homechef-worker","serviceAccount":"homechef-worker"}]}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}

	var body struct {
		PullRequest string `json:"pullRequest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.PullRequest != p.url {
		t.Errorf("pullRequest = %q, want the URL the proposer returned", body.PullRequest)
	}

	if p.first().Add == nil || p.first().Add.Name != "homechef-worker" {
		t.Fatalf("proposer saw %+v, want an add for homechef-worker", p.seen)
	}
	if p.first().Remove != nil {
		t.Error("an add also asked for a removal")
	}
}

// A secret shared by several apps is one decision, so it must be one review.
func TestProposeCarriesEveryAppInOnePullRequest(t *testing.T) {
	p := &stubProposer{url: "https://github.com/tesserix/tesserix-k8s/pull/14"}

	rec := serve(t, p, http.MethodPost, "/api/access/whitelist",
		`{"namespace":"homechef","apps":[{"name":"homechef-api","serviceAccount":"homechef-api"},{"name":"homechef-web","serviceAccount":"homechef-web"}]}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	if len(p.seen) != 2 {
		t.Fatalf("proposer saw %+v, want both apps in one proposal", p.seen)
	}
	if p.seen[1].Add == nil || p.seen[1].Add.Name != "homechef-web" {
		t.Fatalf("second change = %+v, want an add for homechef-web", p.seen[1])
	}
}

func TestWithdrawProposesARemoval(t *testing.T) {
	p := &stubProposer{url: "https://github.com/tesserix/tesserix-k8s/pull/13"}

	rec := serve(t, p, http.MethodDelete, "/api/access/whitelist/ai-database/qdrant", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	if p.first().Remove == nil || p.first().Remove.Namespace != "ai-database" || p.first().Remove.Name != "qdrant" {
		t.Fatalf("proposer saw %+v, want a removal of ai-database/qdrant", p.seen)
	}
}

// The pull request is reviewed by the other administrator, so it has to say who
// asked for it even when the session middleware is not in the chain.
func TestProposeRefusesWithoutAnActor(t *testing.T) {
	p := &stubProposer{url: "https://example.invalid/pull/1"}
	p.err = errors.New("gitops: a change must name the administrator requesting it")

	rec := serve(t, p, http.MethodPost, "/api/access/whitelist",
		`{"namespace":"homechef","apps":[{"name":"homechef-worker","serviceAccount":"homechef-worker"}]}`)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 when GitHub rejects the change", rec.Code)
	}
}

func TestProposeRejectsAnIncompleteBody(t *testing.T) {
	rec := serve(t, &stubProposer{}, http.MethodPost, "/api/access/whitelist", `{"namespace":"homechef"}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a body missing the app", rec.Code)
	}
}

// Without a token the rest of the console still works; this one call must say
// so plainly rather than failing as though GitHub were down.
func TestProposeReportsThatGitOpsIsNotConfigured(t *testing.T) {
	rec := serve(t, nil, http.MethodPost, "/api/access/whitelist",
		`{"namespace":"homechef","apps":[{"name":"homechef-worker","serviceAccount":"homechef-worker"}]}`)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 without a configured repository", rec.Code)
	}
}

type stubRewirer struct {
	stubProposer
	req gitops.WiringRequest
}

func (s *stubRewirer) ProposeWiring(_ context.Context, req gitops.WiringRequest) (string, error) {
	s.req = req
	return s.url, s.err
}

const wiringBody = `{"namespace":"cloudflared","app":"cloudflared","chartPath":"charts/infrastructure/cloudflared","valuesFile":"values.yaml","remoteKey":"cloudflared/cloudflared/tunnel","remoteProperty":"token"}`

func TestRewireReturnsThePullRequestURL(t *testing.T) {
	p := &stubRewirer{stubProposer: stubProposer{url: "https://github.com/tesserix/tesserix-k8s/pull/15"}}

	rec := serve(t, p, http.MethodPost, "/api/access/wiring", wiringBody)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if body["pullRequest"] != "https://github.com/tesserix/tesserix-k8s/pull/15" {
		t.Errorf("pullRequest = %v, want the URL the proposer returned", body["pullRequest"])
	}
	if p.req.App != "cloudflared" || p.req.ChartPath != "charts/infrastructure/cloudflared" {
		t.Errorf("request reached the proposer as %+v", p.req)
	}
	if p.req.RemoteProperty != "token" {
		t.Errorf("remoteProperty = %q, want the key within the payload", p.req.RemoteProperty)
	}
}

func TestRewireRejectsABodyMissingTheChart(t *testing.T) {
	p := &stubRewirer{}

	rec := serve(t, p, http.MethodPost, "/api/access/wiring",
		`{"namespace":"cloudflared","app":"cloudflared"}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body)
	}
}

// A Proposer that cannot rewire is not an error at startup, but the route has
// to say so rather than reporting a proposal it never made.
func TestRewireReportsAProposerThatCannotRewire(t *testing.T) {
	rec := serve(t, &stubProposer{}, http.MethodPost, "/api/access/wiring", wiringBody)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body %s", rec.Code, rec.Body)
	}
}

func TestRewireReportsAFailureFromTheProposer(t *testing.T) {
	p := &stubRewirer{stubProposer: stubProposer{err: errors.New("chart has no externalSecrets block")}}

	rec := serve(t, p, http.MethodPost, "/api/access/wiring", wiringBody)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "externalSecrets") {
		t.Errorf("response %s hides the reason", rec.Body)
	}
}

// A whitelist that already says what was asked for is the requested state, so
// the operator is told it holds — not handed a bad gateway for a repository
// that answered perfectly well.
func TestProposeAnswersANoOpAsSuccessRatherThanABadGateway(t *testing.T) {
	p := &stubProposer{err: gitops.ErrNoChange}

	rec := serve(t, p, http.MethodPost, "/api/access/whitelist",
		`{"namespace":"homechef","apps":[{"name":"homechef-api","serviceAccount":"homechef-api"}]}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 when the change is already in place; body %s", rec.Code, rec.Body)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["pullRequest"]; ok {
		t.Errorf("body %s carries a pull request URL for a proposal that was never opened", rec.Body)
	}
	if body["status"] != "unchanged" {
		t.Errorf("status = %v, want the body to say nothing needed changing", body["status"])
	}
}

func TestWithdrawAnswersANoOpAsSuccess(t *testing.T) {
	p := &stubProposer{err: gitops.ErrNoChange}

	rec := serve(t, p, http.MethodDelete, "/api/access/whitelist/ai-database/never-existed", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for withdrawing an entry that was never there; body %s", rec.Code, rec.Body)
	}
}

// The trail has to separate a proposal that opened a pull request from one that
// found the work already done, and neither may be filed as an error: a record
// that cannot tell the three apart evidences nothing.
func TestTheAuditTrailSeparatesAProposalFromANoOp(t *testing.T) {
	const request = `{"namespace":"homechef","apps":[{"name":"homechef-api","serviceAccount":"homechef-api"}]}`

	_, proposed := serveAudited(t, &stubProposer{url: "https://example.invalid/pull/1"},
		http.MethodPost, "/api/access/whitelist", request)
	_, unchanged := serveAudited(t, &stubProposer{err: gitops.ErrNoChange},
		http.MethodPost, "/api/access/whitelist", request)
	_, failed := serveAudited(t, &stubProposer{err: errors.New("values.yaml is unreadable")},
		http.MethodPost, "/api/access/whitelist", request)

	if strings.Contains(unchanged, `"outcome":"error"`) {
		t.Errorf("a no-op was recorded as an error: %s", unchanged)
	}
	if !strings.Contains(unchanged, "already in place") {
		t.Errorf("a no-op is recorded indistinguishably from a proposal: %s", unchanged)
	}
	if strings.Contains(proposed, "already in place") {
		t.Errorf("a proposal that opened a pull request was recorded as a no-op: %s", proposed)
	}
	if !strings.Contains(failed, `"outcome":"error"`) {
		t.Errorf("a failed proposal was not recorded as an error: %s", failed)
	}
}
