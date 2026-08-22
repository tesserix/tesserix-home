package handler_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// The module is exercised through its REAL router, its real verifier and a
// real (httptest) product server standing in for mark8ly. Only the token's
// signature is faked.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
	productSlug     = "mark8ly"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:   subjectOperator,
		Email:     "operator@tesserix.test",
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

type api struct {
	handler http.Handler
	t       *testing.T
}

// serve builds an api with an operator holding `platform`, the capability
// this module gates its one route on.
func serve(t *testing.T) *api { t.Helper(); return serveAs(t, "platform") }

// serveAs mounts the module behind httpx.RegisterModule and httpx.WithMiddleware
// — exactly what cmd/server composes — with a product server standing in for
// mark8ly's /admin/audit-logs endpoint, returning one row.
func serveAs(t *testing.T, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"1","action":"tenant.suspended","created_at":"2026-08-22T10:00:00Z"}]}`))
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	// Through RegisterModule and the module's own Register, because that is
	// where the "no verifier, no module" guard lives. This composes what
	// cmd/server composes, line for line.
	httpx.RegisterModule(mux, verifier, "audit", func(m *http.ServeMux) {
		audit.Register(m, audit.Config{
			Fed: fed, Slugs: []string{productSlug}, Verifier: verifier, Log: log,
		})
	})

	return &api{handler: httpx.WithMiddleware(mux), t: t}
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a *api) do(method, path, body string, headers map[string]string) response {
	a.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	// Every answer is enveloped, refusals included, so a body that will not
	// parse is a finding rather than an inconvenience.
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a *api) get(path string) response { a.t.Helper(); return a.do(http.MethodGet, path, "", nil) }

// data returns the response's `data` object, failing if the call did not
// succeed.
func (r response) data(t *testing.T) map[string]any {
	t.Helper()
	if r.body["success"] != true {
		t.Fatalf("not a success: %s", r.raw)
	}
	data, ok := r.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %s", r.raw)
	}
	return data
}

func TestGetAuditWithPlatformReturnsEntriesAndFailuresAsArrays(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/audit").data(t)

	entries, ok := got["entries"].([]any)
	if !ok {
		t.Fatalf("data.entries is not an array: %v", got)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	first, _ := entries[0].(map[string]any)
	if first["source"] != productSlug {
		t.Errorf("source = %v, want %s", first["source"], productSlug)
	}

	// Failures must be an array too, even when empty — a nil slice serialises
	// as null and this estate has already crashed a page over exactly that.
	failures, ok := got["failures"].([]any)
	if !ok {
		t.Fatalf("data.failures is not an array: %v", got)
	}
	if len(failures) != 0 {
		t.Errorf("failures = %v, want none — the one configured product answered", failures)
	}
}

func TestGetAuditWithAnUnknownSourceIsFourHundredWithNoEntriesKey(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/audit?source=nope")

	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — a typo'd filter must not look like 'nothing happened': %s", got.status, got.raw)
	}
	// Proves the zero-value domain.Page{} — with its nil slices — was never
	// marshalled onto the wire.
	if data, ok := got.body["data"].(map[string]any); ok {
		if _, present := data["entries"]; present {
			t.Fatalf("body = %s, want no entries key on an error response", got.raw)
		}
	}
	if strings.Contains(got.raw, `"entries"`) {
		t.Fatalf("body = %s, want no entries key anywhere on an error response", got.raw)
	}
}

func TestGetAuditWithoutPlatformIsFourOhThree(t *testing.T) {
	a := serveAs(t, "read")

	got := a.get("/v1/audit")

	if got.status != http.StatusForbidden {
		t.Errorf("GET /v1/audit with `read` (no `platform`) = %d, want 403: %s", got.status, got.raw)
	}
}

// Genuinely exercises auth.Authenticate — the request never carries an
// Authorization header, so the request never reaches the audit handler's own
// principal check at all; it is refused by the middleware wrapping the mux.
func TestGetAuditWithNoAuthorizationHeaderIsFourOhOne(t *testing.T) {
	a := serve(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/audit", nil)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", rec.Code)
	}
}
