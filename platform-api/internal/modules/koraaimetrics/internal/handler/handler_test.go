package handler_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/koraaimetrics"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
	koraSlug        = "kora"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject: subjectOperator, Email: "operator@tesserix.test",
		Audience: []string{projectID}, Issuer: "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour), Roles: roles,
	}
}

type api struct {
	handler http.Handler
	t       *testing.T
}

func serve(t *testing.T) *api {
	t.Helper()
	return serveKora(t, http.StatusOK, `{"data":{"window":{"from":"a","to":"b"},"outcomes":{"attempts":1}}}`, true)
}

// serveKora mounts the module through httpx.RegisterModule — what
// cmd/server composes — over a stub standing in for Kora. configured governs
// whether "kora" is declared in the federation registry at all.
func serveKora(t *testing.T, status int, body string, configured bool) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(product.Close)

	var products []federation.Product
	if configured {
		products = []federation.Product{{Slug: koraSlug, BaseURL: product.URL, Secret: "test-secret"}}
	}
	fed := federation.NewClient(federation.NewRegistry(products), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor("platform")}, projectID)
	httpx.RegisterModule(mux, verifier, "koraaimetrics", func(m *http.ServeMux) {
		koraaimetrics.Register(m, koraaimetrics.Config{Fed: fed, Verifier: verifier, Log: log})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t}
}

// serveKoraRecordingQuery is serveKora plus a hook that captures the query
// string Kora actually received, so a test can assert the window and paging
// parameters were forwarded rather than dropped or reinterpreted.
func serveKoraRecordingQuery(t *testing.T, captured *url.Values) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*captured = r.URL.Query()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{}}`))
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: koraSlug, BaseURL: product.URL, Secret: "test-secret"},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor("platform")}, projectID)
	httpx.RegisterModule(mux, verifier, "koraaimetrics", func(m *http.ServeMux) {
		koraaimetrics.Register(m, koraaimetrics.Config{Fed: fed, Verifier: verifier, Log: log})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t}
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a *api) do(method, path string) response {
	a.t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a *api) get(path string) response { a.t.Helper(); return a.do(http.MethodGet, path) }

// THE assertion this module exists for: Kora's `data` object reaches the
// console DIRECTLY under this service's own `data` — no double nesting —
// including a field platform-api never named, and Kora's pagination lands in
// this service's own `meta` channel rather than buried inside `data`.
func TestReadForwardsKorasPayloadDirectlyAndProjectsPagination(t *testing.T) {
	body := `{"data":{"window":{"from":"a","to":"b"},"outcomes":{"attempts":4,"by_kind":{"exact":3}},` +
		`"users":[{"user_id":"u1","attempts":4,"sublabel":"unexpected but present"}]},"pagination":{"page":1,"limit":50,"total":1}}`
	got := serveKora(t, http.StatusOK, body, true).get("/v1/kora/ai-metrics")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}

	data, _ := got.body["data"].(map[string]any)
	if _, nested := data["data"]; nested {
		t.Fatalf("data.data is present, want Kora's payload unwrapped directly under data: %s", got.raw)
	}
	if _, ok := data["outcomes"]; !ok {
		t.Fatalf("data.outcomes is missing, want Kora's payload directly under data: %s", got.raw)
	}
	users, _ := data["users"].([]any)
	if len(users) != 1 {
		t.Fatalf("data.users = %v, want Kora's one row carried through; raw=%s", data["users"], got.raw)
	}
	row, _ := users[0].(map[string]any)
	if row["sublabel"] != "unexpected but present" {
		t.Errorf("row = %v, want a field platform-api never modelled to survive the hop (§8.9)", row)
	}

	meta, _ := got.body["meta"].(map[string]any)
	if meta["total"] != float64(1) {
		t.Errorf("meta.total = %v, want Kora's pagination.total projected into meta", meta["total"])
	}
	if meta["limit"] != float64(50) {
		t.Errorf("meta.limit = %v, want Kora's pagination.limit projected into meta", meta["limit"])
	}
	if _, present := meta["page"]; present {
		t.Errorf("meta.page is present; httpx.Meta is cursor-oriented and has no page field")
	}
}

// 404 must reach the console as 404, distinguishing an unmounted Kora route
// from every other kind of failure.
func TestRead404SurvivesTheHop(t *testing.T) {
	a := serveKora(t, http.StatusNotFound, `{"error":"not_found"}`, true)
	if got := a.get("/v1/kora/ai-metrics"); got.status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 carried through: %s", got.status, got.raw)
	}
}

// 501 must reach the console as 501, kept distinct from 404.
func TestRead501SurvivesTheHop(t *testing.T) {
	a := serveKora(t, http.StatusNotImplemented, `{"error":"not_implemented"}`, true)
	if got := a.get("/v1/kora/ai-metrics"); got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501 carried through: %s", got.status, got.raw)
	}
}

// The dangerous inversion: an unreachable Kora must not be reported as 404
// or 501 — either would tell an operator a contract statement was made when
// none was.
func TestReadReportsAnOutageAsUnavailableNotAsAContractStatement(t *testing.T) {
	a := serveKora(t, http.StatusBadGateway, `{"error":"boom"}`, true)
	got := a.get("/v1/kora/ai-metrics")
	if got.status == http.StatusNotFound || got.status == http.StatusNotImplemented {
		t.Fatalf("an outage was reported as %d, a contract statement Kora never made: %s", got.status, got.raw)
	}
	if got.status != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503: %s", got.status, got.raw)
	}
}

// A deployment that has not declared kora in FEDERATION_PRODUCTS answers 501:
// a deployment fact, not something Kora said.
func TestReadIsNotImplementedWhenKoraIsNotConfigured(t *testing.T) {
	a := serveKora(t, http.StatusOK, `{"data":{}}`, false)
	if got := a.get("/v1/kora/ai-metrics"); got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
}

func TestReadRejectsUnknownParameters(t *testing.T) {
	a := serve(t)
	if got := a.get("/v1/kora/ai-metrics?source=kora"); got.status != http.StatusBadRequest {
		t.Errorf("unknown param: status = %d, want 400", got.status)
	}
}

// The window and paging parameters are part of the signed canonical query —
// see federation.Client — so they must reach Kora exactly as the caller sent
// them, not be dropped or reinterpreted along the way.
func TestReadForwardsWindowAndPagingParameters(t *testing.T) {
	var captured url.Values
	a := serveKoraRecordingQuery(t, &captured)
	a.get("/v1/kora/ai-metrics?from=2026-08-01T00:00:00Z&to=2026-08-28T00:00:00Z&page=2&limit=50")

	for param, want := range map[string]string{
		"from": "2026-08-01T00:00:00Z", "to": "2026-08-28T00:00:00Z", "page": "2", "limit": "50",
	} {
		if got := captured.Get(param); got != want {
			t.Errorf("kora received %s=%q, want %q", param, got, want)
		}
	}
}
