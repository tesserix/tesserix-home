package handlers_test

import (
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
	"github.com/tesserix/tesserix-home/secrets-api/internal/bao"
	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

var errNoRepo = errors.New("gitops: values.yaml is unreadable")

// stubBaoServer accepts every write and answers reads with an empty object, so
// a grant against it succeeds and reads back.
func stubBaoServer(t *testing.T) *bao.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"keys": []string{}}})
	}))
	t.Cleanup(srv.Close)

	client, err := bao.New(bao.Config{Address: srv.URL, Mount: "kv", Token: "test-token"})
	if err != nil {
		t.Fatalf("bao.New: %v", err)
	}
	return client
}

func grant(t *testing.T, p handlers.Proposer, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)

	r := gin.New()
	handlers.NewAccess(stubBaoServer(t), p, audit.New(io.Discard)).Register(r)

	req := httptest.NewRequest(http.MethodPost, "/api/access/grants", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// A grant lives in OpenBao's raft store, which no repository describes. Unless
// the same action records it in tesserix-k8s, a rebuilt OpenBao comes back
// without it and ESO is never wired to the app at all.
func TestGrantAlsoProposesTheWhitelistChange(t *testing.T) {
	p := &stubProposer{url: "https://github.com/tesserix/tesserix-k8s/pull/245"}

	rec := grant(t, p, `{"namespace":"dwellm8","apps":[{"name":"dwellm8-api","serviceAccount":"dwellm8-api"}],"ttl":"0"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}

	if len(p.seen) != 1 || p.first().Add == nil || p.first().Add.Name != "dwellm8-api" {
		t.Fatalf("proposed %+v, want the granted app whitelisted", p.seen)
	}

	var body struct {
		PullRequest string `json:"pullRequest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.PullRequest != p.url {
		t.Errorf("pullRequest = %q, want the proposal URL", body.PullRequest)
	}
}

// The OpenBao side already stands at this point. Reporting failure would invite
// a retry that grants twice, so the grant is returned along with the reason the
// repository was not updated.
func TestGrantReportsAFailedProposalWithoutLosingTheGrant(t *testing.T) {
	p := &stubProposer{err: errNoRepo}

	rec := grant(t, p, `{"namespace":"dwellm8","apps":[{"name":"dwellm8-api","serviceAccount":"dwellm8-api"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}

	var body struct {
		Grants        []bao.Grant `json:"grants"`
		ProposalError string      `json:"proposalError"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Grants) != 1 {
		t.Fatalf("grants = %+v, want the grant that stands", body.Grants)
	}
	if !strings.Contains(body.ProposalError, errNoRepo.Error()) {
		t.Errorf("proposalError = %q, want the reason the proposal failed", body.ProposalError)
	}
}

func TestGrantWithoutARepositorySaysSo(t *testing.T) {
	rec := grant(t, nil, `{"namespace":"dwellm8","apps":[{"name":"dwellm8-api","serviceAccount":"dwellm8-api"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "proposalError") {
		t.Errorf("body = %s, want it to say the grant was not recorded in Git", rec.Body)
	}
}

// The grant stands in OpenBao and tesserix-k8s already describes it. Filing
// that as a proposalError would tell the operator their grant was not recorded
// in Git when it was — recorded by an earlier proposal, but recorded.
func TestGrantDoesNotReportAnAlreadyRecordedWhitelistAsAFailure(t *testing.T) {
	p := &stubProposer{err: gitops.ErrNoChange}

	rec := grant(t, p, `{"namespace":"dwellm8","apps":[{"name":"dwellm8-api","serviceAccount":"dwellm8-api"}],"ttl":"0"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, failed := body["proposalError"]; failed {
		t.Errorf("body %s reports a failure for a whitelist that already records the grant", rec.Body)
	}
	if _, opened := body["pullRequest"]; opened {
		t.Errorf("body %s links a pull request that was never opened", rec.Body)
	}
	if body["proposal"] != "unchanged" {
		t.Errorf("proposal = %v, want the body to say the whitelist already records the grant", body["proposal"])
	}
}
