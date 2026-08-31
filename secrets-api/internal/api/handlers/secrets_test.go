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
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

// recorder is a Store that answers everything and remembers the last path it
// was asked about, so a test can tell which backend a request reached.
type recorder struct {
	name          string
	lastPath      string
	lastIfVersion int
	lastRestored  int
	conflict      bool
	unhealthy     error
}

func (s *recorder) List(_ context.Context, prefix string) ([]secrets.Entry, error) {
	s.lastPath = prefix
	return []secrets.Entry{{Name: s.name}}, nil
}

func (s *recorder) Describe(_ context.Context, path string) (secrets.Secret, error) {
	s.lastPath = path
	return secrets.Secret{Path: path, Keys: []string{s.name}}, nil
}

func (s *recorder) Write(_ context.Context, path string, _ map[string]string, ifVersion int) (int, error) {
	s.lastPath, s.lastIfVersion = path, ifVersion
	if s.conflict {
		return 0, secrets.ErrConflict
	}
	return 1, nil
}

func (s *recorder) Delete(_ context.Context, path string) error  { s.lastPath = path; return nil }
func (s *recorder) Destroy(_ context.Context, path string) error { s.lastPath = path; return nil }

func (s *recorder) Restore(_ context.Context, path string, version int) error {
	s.lastPath, s.lastRestored = path, version
	return nil
}

func (s *recorder) Health(context.Context) error { return s.unhealthy }

func (s *recorder) Versions(_ context.Context, path string) ([]secrets.Version, error) {
	s.lastPath = path
	return []secrets.Version{{Version: 1}}, nil
}

func secretsRouter(t *testing.T) (*gin.Engine, *recorder, *recorder, *bytes.Buffer) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	bao, gcp := &recorder{name: "openbao"}, &recorder{name: "gcpsm"}
	registry, err := secrets.NewRegistry(secrets.BackendOpenBao, map[secrets.Backend]secrets.Store{
		secrets.BackendOpenBao: bao,
		secrets.BackendGCPSM:   gcp,
	})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	log := &bytes.Buffer{}
	r := gin.New()
	handlers.NewSecrets(registry, audit.New(log)).Register(r, r)
	return r, bao, gcp, log
}

func get(t *testing.T, r *gin.Engine, target string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
	return w
}

func send(t *testing.T, r *gin.Engine, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

// The version the form was drawn from travels with the write, so a second
// administrator's change cannot be overwritten without anyone noticing.
func TestWriteCarriesTheExpectedVersionToTheStore(t *testing.T) {
	r, bao, _, _ := secretsRouter(t)

	w := send(t, r, http.MethodPut, "/api/secrets/homechef/api/db", `{"data":{"password":"x"},"ifVersion":7}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	if bao.lastIfVersion != 7 {
		t.Fatalf("store saw ifVersion %d, want 7", bao.lastIfVersion)
	}
}

func TestWriteAnsweredWithAConflictReports409(t *testing.T) {
	r, bao, _, _ := secretsRouter(t)
	bao.conflict = true

	w := send(t, r, http.MethodPut, "/api/secrets/homechef/api/db", `{"data":{"password":"x"},"ifVersion":7}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body %s", w.Code, w.Body)
	}
}

func TestRestoreBringsBackTheNamedVersion(t *testing.T) {
	r, bao, _, log := secretsRouter(t)

	w := send(t, r, http.MethodPost, "/api/secret-versions/homechef/api/db", `{"version":3}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	if bao.lastRestored != 3 {
		t.Fatalf("store restored version %d, want 3", bao.lastRestored)
	}
	if !strings.Contains(log.String(), `"secret.restore"`) {
		t.Fatalf("audit log = %s, want a secret.restore event", log)
	}
}

func TestRestoreRefusesAVersionThatIsNotPositive(t *testing.T) {
	r, bao, _, _ := secretsRouter(t)

	w := send(t, r, http.MethodPost, "/api/secret-versions/homechef/api/db", `{"version":0}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if bao.lastRestored != 0 {
		t.Fatalf("store restored version %d, want none", bao.lastRestored)
	}
}

func TestSecretsUseTheDefaultBackendWhenNoneIsNamed(t *testing.T) {
	r, bao, gcp, _ := secretsRouter(t)

	if w := get(t, r, "/api/secrets?prefix=homechef"); w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	if bao.lastPath != "homechef" {
		t.Fatalf("openbao saw %q, want the request", bao.lastPath)
	}
	if gcp.lastPath != "" {
		t.Fatalf("gcpsm saw %q, want nothing", gcp.lastPath)
	}
}

func TestSecretsHonourTheRequestedBackend(t *testing.T) {
	r, bao, gcp, _ := secretsRouter(t)

	if w := get(t, r, "/api/secrets/homechef/api/db?backend=gcpsm"); w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	if gcp.lastPath != "/homechef/api/db" {
		t.Fatalf("gcpsm saw %q", gcp.lastPath)
	}
	if bao.lastPath != "" {
		t.Fatalf("openbao saw %q, want nothing", bao.lastPath)
	}
}

func TestSecretsRefuseABackendThatIsNotEnabled(t *testing.T) {
	r, _, _, _ := secretsRouter(t)

	w := get(t, r, "/api/secrets?backend=aws-secrets-manager")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestBackendsListsWhatTheDeploymentEnabled(t *testing.T) {
	r, _, _, _ := secretsRouter(t)

	w := get(t, r, "/api/backends")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}

	var body struct {
		Backends []string `json:"backends"`
		Default  string   `json:"default"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(body.Backends) != 2 || body.Default != "openbao" {
		t.Fatalf("body = %+v", body)
	}
}

// A sealed or unreachable store makes every other request fail for reasons the
// console cannot explain, so it is asked once and said plainly.
func TestBackendStatusReportsEachStore(t *testing.T) {
	r, bao, _, _ := secretsRouter(t)
	bao.unhealthy = errors.New("bao: not ready (initialized=true sealed=true)")

	w := get(t, r, "/api/backends/status")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}

	var body struct {
		Status []struct {
			Backend string `json:"backend"`
			Healthy bool   `json:"healthy"`
			Detail  string `json:"detail"`
		} `json:"status"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(body.Status) != 2 {
		t.Fatalf("status = %+v, want both backends", body.Status)
	}
	for _, s := range body.Status {
		switch s.Backend {
		case "openbao":
			if s.Healthy || !strings.Contains(s.Detail, "sealed=true") {
				t.Fatalf("openbao = %+v, want unhealthy with the reason", s)
			}
		case "gcpsm":
			if !s.Healthy {
				t.Fatalf("gcpsm = %+v, want healthy", s)
			}
		}
	}
}

func TestSecretsRecordTheBackendInTheAuditLog(t *testing.T) {
	r, _, _, log := secretsRouter(t)

	if w := get(t, r, "/api/secrets/homechef/api/db?backend=gcpsm"); w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}

	var event struct {
		Action  string `json:"action"`
		Backend string `json:"backend"`
		Target  string `json:"target"`
	}
	line := strings.TrimSpace(log.String())
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		t.Fatalf("audit line %q: %v", line, err)
	}
	if event.Backend != "gcpsm" || event.Action != "secret.describe" {
		t.Fatalf("audit event = %+v", event)
	}
}
