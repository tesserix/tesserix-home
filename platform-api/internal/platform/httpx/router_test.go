package httpx_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

type stubChecker struct{ err error }

func (s stubChecker) Health(context.Context) error { return s.err }

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func get(t *testing.T, deps httpx.Checker, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	httpx.Router(deps, nil, discardLogger()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// The distinction the two probes exist for: a liveness probe that fails on a
// dependency outage asks Kubernetes to restart a working process, which cannot
// bring the database back and adds restart churn to an incident.
func TestHealthIgnoresTheDatabase(t *testing.T) {
	rec := get(t, stubChecker{err: errors.New("connection refused")}, "/health")

	if rec.Code != http.StatusOK {
		t.Errorf("liveness must not depend on the database; got %d", rec.Code)
	}
}

func TestReadyFailsWhenTheDatabaseIsUnreachable(t *testing.T) {
	rec := get(t, stubChecker{err: errors.New("connection refused")}, "/ready")

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("want 503, got %d", rec.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("readiness failure must still be JSON: %v (%s)", err, rec.Body)
	}
	details, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("the failure is not the estate envelope: %s", rec.Body.String())
	}
	// #198's distinction, from day one: unreachable is not broken.
	if details["code"] != httpx.CodeUnavailable {
		t.Errorf("want %s, got %v", httpx.CodeUnavailable, details["code"])
	}
	// The driver's message must not reach the client.
	if msg, _ := details["message"].(string); msg == "connection refused" {
		t.Error("the underlying driver error leaked into the response")
	}
}

func TestReadySucceedsWhenTheDatabaseAnswers(t *testing.T) {
	rec := get(t, stubChecker{}, "/ready")

	if rec.Code != http.StatusOK {
		t.Errorf("want 200, got %d (%s)", rec.Code, rec.Body)
	}
}

func TestProbesAnswerJSON(t *testing.T) {
	for _, path := range []string{"/health", "/ready"} {
		rec := get(t, stubChecker{}, path)
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("%s: want application/json, got %q", path, ct)
		}
	}
}

// The probes go through the same envelope as everything else.
//
// Kubernetes reads only the status code, so this buys nothing operationally —
// it buys the rule. "Every response from this service is a StandardResponse"
// is a statement a client can rely on; "every response except the two probes"
// is a statement someone has to look up.
func TestProbesUseTheEnvelope(t *testing.T) {
	for _, path := range []string{"/health", "/ready"} {
		rec := get(t, stubChecker{}, path)

		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if body["success"] != true {
			t.Errorf("%s: success = %v, want true", path, body["success"])
		}
		data, ok := body["data"].(map[string]any)
		if !ok || data["status"] == "" {
			t.Errorf("%s: the probe payload did not land under data: %v", path, body["data"])
		}
	}
}

// A readiness failure is SERVICE_UNAVAILABLE, not an internal error — the
// distinction #198 exists for. Nothing is broken; a dependency is unreachable.
func TestReadyRefusesThroughTheErrorEnvelope(t *testing.T) {
	rec := get(t, stubChecker{err: errors.New("connection refused")}, "/ready")

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["success"] != false {
		t.Errorf("success = %v, want false", body["success"])
	}
	details, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("error is missing: %s", rec.Body.String())
	}
	if details["code"] != httpx.CodeUnavailable {
		t.Errorf("error.code = %v, want %q", details["code"], httpx.CodeUnavailable)
	}
}

func TestUnknownRouteIs404(t *testing.T) {
	rec := get(t, stubChecker{}, "/tickets")
	if rec.Code != http.StatusNotFound {
		t.Errorf("want 404 for an unregistered route, got %d", rec.Code)
	}
}

// The guard that keeps "authentication disabled" from outliving its purpose.
//
// A nil verifier is legitimate only while this router serves probes alone.
// Registering a domain module without one would mean an unauthenticated API,
// and a checklist item would be forgotten exactly once — silently.
func TestRegisteringAModuleWithoutAVerifierPanics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("registering a module with authentication disabled must panic")
		}
		msg, _ := r.(string)
		// The message has to say what to do; a bare panic at wiring time is a
		// stack trace with no instruction in it.
		if !strings.Contains(msg, "PLATFORM_API_AUTH_ENABLED") {
			t.Errorf("the panic should name the variable to set, got %q", msg)
		}
		if !strings.Contains(msg, "tickets") {
			t.Errorf("the panic should name the module, got %q", msg)
		}
	}()

	httpx.RegisterModule(http.NewServeMux(), nil, "tickets", func(*http.ServeMux) {
		t.Error("the module must not be registered")
	})
}

// Guards the composition root's contract: /v1/audit exists only because a
// module registered it. A 404 here means nothing has silently claimed the
// path.
func TestAuditRouteIsNotServedWithoutAModule(t *testing.T) {
	if rec := get(t, stubChecker{}, "/v1/audit"); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 on a bare router", rec.Code)
	}
}

// The other half: with a verifier it registers normally.
func TestRegisteringAModuleWithAVerifierWorks(t *testing.T) {
	registered := false

	httpx.RegisterModule(http.NewServeMux(), &auth.Verifier{}, "tickets", func(*http.ServeMux) {
		registered = true
	})

	if !registered {
		t.Error("a module should register when authentication is on")
	}
}
