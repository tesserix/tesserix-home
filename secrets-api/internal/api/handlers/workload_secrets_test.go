package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/handlers"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/workloadauth"
)

type workloadWriter struct {
	path      string
	data      map[string]string
	ifVersion int
	deleted   bool
}

func (w *workloadWriter) Write(_ context.Context, path string, data map[string]string, ifVersion int) (int, error) {
	w.path, w.data, w.ifVersion = path, data, ifVersion
	return 4, nil
}

func (w *workloadWriter) Delete(_ context.Context, path string) error {
	w.path, w.deleted = path, true
	return nil
}

type workloadReviewer struct {
	identity workloadauth.Identity
	err      error
}

func (r workloadReviewer) Review(context.Context, string, string) (workloadauth.Identity, error) {
	return r.identity, r.err
}

func workloadRouter(t *testing.T, subject string) (*gin.Engine, *workloadWriter, *bytes.Buffer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	writer := &workloadWriter{}
	log := &bytes.Buffer{}
	h, err := handlers.NewWorkloadSecrets(handlers.WorkloadSecretsConfig{
		Audience:        "secret-service",
		AllowedSubjects: []string{"system:serviceaccount:devai:devai-api"},
		Namespace:       "devai",
		App:             "devai-api",
	}, workloadReviewer{identity: workloadauth.Identity{Subject: subject}}, writer, audit.New(log))
	if err != nil {
		t.Fatalf("NewWorkloadSecrets: %v", err)
	}
	r := gin.New()
	h.Register(r)
	return r, writer, log
}

func workloadRequest(t *testing.T, r http.Handler, method, target, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestWorkloadSecretWriteUsesFixedPrefixAndAuditsMetadata(t *testing.T) {
	r, writer, log := workloadRouter(t, "system:serviceaccount:devai:devai-api")

	w := workloadRequest(t, r, http.MethodPut,
		"/internal/v1/workload-secrets/0123456789abcdef0123456789abcdef/llm-anthropic-key",
		`{"value":"never-log-me","ifVersion":3}`, "projected-token")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}
	if writer.path != "devai/devai-api/0123456789abcdef0123456789abcdef/llm-anthropic-key" {
		t.Fatalf("path = %q", writer.path)
	}
	if writer.data["value"] != "never-log-me" || writer.ifVersion != 3 {
		t.Fatalf("write = %#v version=%d", writer.data, writer.ifVersion)
	}
	if strings.Contains(log.String(), "never-log-me") {
		t.Fatalf("audit leaked secret value: %s", log)
	}
	if !strings.Contains(log.String(), `"actor":"system:serviceaccount:devai:devai-api"`) ||
		!strings.Contains(log.String(), `"keys":["value"]`) {
		t.Fatalf("audit = %s", log)
	}

	var response struct {
		Path    string `json:"path"`
		Version int    `json:"version"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("response: %v", err)
	}
	if response.Version != 4 || response.Path != writer.path {
		t.Fatalf("response = %+v", response)
	}
}

func TestWorkloadSecretDeleteIsSoftDelete(t *testing.T) {
	r, writer, _ := workloadRouter(t, "system:serviceaccount:devai:devai-api")
	w := workloadRequest(t, r, http.MethodDelete,
		"/internal/v1/workload-secrets/0123456789abcdef0123456789abcdef/llm-anthropic-key", "", "projected-token")
	if w.Code != http.StatusNoContent || !writer.deleted {
		t.Fatalf("status=%d deleted=%t body=%s", w.Code, writer.deleted, w.Body)
	}
}

func TestWorkloadSecretsRejectMissingTokenAndWrongSubject(t *testing.T) {
	r, writer, _ := workloadRouter(t, "system:serviceaccount:other:pod")
	target := "/internal/v1/workload-secrets/0123456789abcdef0123456789abcdef/key"
	if w := workloadRequest(t, r, http.MethodPut, target, `{"value":"x"}`, ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status = %d", w.Code)
	}
	if w := workloadRequest(t, r, http.MethodPut, target, `{"value":"x"}`, "token"); w.Code != http.StatusNotFound {
		t.Fatalf("wrong subject status = %d", w.Code)
	}
	if writer.path != "" {
		t.Fatalf("unauthorized request reached store: %q", writer.path)
	}
}

func TestWorkloadSecretsRejectInvalidOwnerAndSecretNames(t *testing.T) {
	r, writer, _ := workloadRouter(t, "system:serviceaccount:devai:devai-api")
	for _, target := range []string{
		"/internal/v1/workload-secrets/not-a-hash/key",
		"/internal/v1/workload-secrets/0123456789abcdef0123456789abcdef/UPPER",
	} {
		w := workloadRequest(t, r, http.MethodPut, target, `{"value":"x"}`, "token")
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d", target, w.Code)
		}
	}
	if writer.path != "" {
		t.Fatalf("invalid request reached store: %q", writer.path)
	}
}

func TestWorkloadSecretCapabilityRequiresAnAllowedWorkload(t *testing.T) {
	r, _, _ := workloadRouter(t, "system:serviceaccount:devai:devai-api")
	w := workloadRequest(t, r, http.MethodGet, "/internal/v1/workload-secrets/capabilities", "", "token")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body)
	}
}
