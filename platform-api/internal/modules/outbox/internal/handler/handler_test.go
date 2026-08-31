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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/outbox"
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
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

type api struct {
	handler http.Handler
	t       *testing.T
	// asked receives the URL the stand-in product was called with.
	asked chan string
}

// serve builds an api with an operator holding `platform`, the capability
// this module gates its one route on.
func serve(t *testing.T) *api { t.Helper(); return serveAs(t, "platform") }

// serveNoProducts mounts the same module with an EMPTY registry: the shape
// SlugsImplementing("outbox") returns in production today, before any
// product's FEDERATION_<SLUG>_ENDPOINTS names outbox.
func serveNoProducts(t *testing.T) *api {
	t.Helper()
	return serveSlugs(t, nil, "platform")
}

// serveAs mounts the module behind httpx.RegisterModule and
// httpx.WithMiddleware — exactly what cmd/server composes — with a product
// server standing in for mark8ly's /admin/outbox endpoint, returning one row.
func serveAs(t *testing.T, roles ...string) *api {
	t.Helper()
	return serveSlugs(t, []string{productSlug}, roles...)
}

// serveSlugs is the composition both of the above share. The stand-in
// product records the URL it was asked for, so a test can assert on the
// query the handler forwarded.
func serveSlugs(t *testing.T, slugs []string, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	asked := make(chan string, 4)
	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked <- r.URL.String()
		_, _ = w.Write([]byte(`{"data":[{"id":"1","tenant_id":"t1","aggregate":"order","aggregate_id":"o1","event_type":"order.created","status":"pending","created_at":"2026-08-22T10:00:00Z"}],"pagination":{"page":1,"limit":50,"total":1}}`))
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret"},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	// Through RegisterModule and the module's own Register, because that is
	// where the "no verifier, no module" guard lives. This composes what
	// cmd/server composes, line for line.
	httpx.RegisterModule(mux, verifier, "outbox", func(m *http.ServeMux) {
		outbox.Register(m, outbox.Config{
			Fed: fed, Slugs: slugs, Verifier: verifier, Log: log,
		})
	})

	return &api{handler: httpx.WithMiddleware(mux), t: t, asked: asked}
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
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a *api) get(path string) response { a.t.Helper(); return a.do(http.MethodGet, path, "", nil) }

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

func TestGetOutboxWithPlatformReturnsEventsAndFailuresAsArrays(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/outbox").data(t)

	events, ok := got["events"].([]any)
	if !ok {
		t.Fatalf("data.events is not an array: %v", got)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	first, _ := events[0].(map[string]any)
	if first["source"] != productSlug {
		t.Errorf("source = %v, want %s", first["source"], productSlug)
	}

	// Failures and not_implemented must both be arrays even when empty — a
	// nil slice serialises as null and has already crashed a page in this
	// estate precisely when there was no data.
	failures, ok := got["failures"].([]any)
	if !ok || len(failures) != 0 {
		t.Fatalf("data.failures = %v, want an empty array", got["failures"])
	}
	notImplemented, ok := got["not_implemented"].([]any)
	if !ok || len(notImplemented) != 0 {
		t.Fatalf("data.not_implemented = %v, want an empty array", got["not_implemented"])
	}
}

func TestGetOutboxWithoutPlatformIsFourOhThree(t *testing.T) {
	a := serveAs(t, "read")

	got := a.get("/v1/outbox")

	if got.status != http.StatusForbidden {
		t.Errorf("GET /v1/outbox with `read` (no `platform`) = %d, want 403: %s", got.status, got.raw)
	}
}

// Genuinely exercises auth.Authenticate — the request never carries an
// Authorization header, so it never reaches the outbox handler's own
// principal check; it is refused by the middleware wrapping the mux.
func TestGetOutboxWithNoAuthorizationHeaderIsFourOhOne(t *testing.T) {
	a := serve(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/outbox", nil)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", rec.Code)
	}
}

// TestGetOutboxWithNoConfiguredProductsIsFiveOhOne proves the HTTP surface
// distinguishes "nobody has declared an outbox implementer" from "the outbox
// is empty" — the state SlugsImplementing("outbox") is in today, in
// production, before any product's FEDERATION_<SLUG>_ENDPOINTS names
// outbox.
func TestGetOutboxWithNoConfiguredProductsIsFiveOhOne(t *testing.T) {
	a := serveNoProducts(t)

	got := a.get("/v1/outbox")

	if got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501 — an unconfigured registry must not read as 'nothing is stuck': %s", got.status, got.raw)
	}
	if strings.Contains(got.raw, `"events"`) {
		t.Errorf("body = %s, want no events key: an empty outbox is the very claim this status refuses to make", got.raw)
	}
}

// TestGetOutboxRejectsAnUnknownQueryParameter proves a typo'd filter is
// refused rather than silently ignored.
func TestGetOutboxRejectsAnUnknownQueryParameter(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/outbox?stge=failed")

	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — an unknown parameter must not be silently ignored: %s", got.status, got.raw)
	}
}

// TestGetOutboxForwardsEveryAcceptedFilter proves the six pinned query
// parameters reach the federated request, and status/event_type/tenant_id
// are forwarded verbatim as strings.
func TestGetOutboxForwardsEveryAcceptedFilter(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/outbox?status=failed&event_type=order.created&older_than_minutes=60&since_hours=24&tenant_id=11111111-1111-1111-1111-111111111111&page=2&limit=50")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}

	asked := <-a.asked
	for _, want := range []string{
		"status=failed", "event_type=order.created", "older_than_minutes=60",
		"since_hours=24", "tenant_id=11111111-1111-1111-1111-111111111111",
		"page=2", "limit=50",
	} {
		if !strings.Contains(asked, want) {
			t.Errorf("product was asked for %q, missing %q", asked, want)
		}
	}
}

// TestGetOutboxRefusesANonPositiveIntegerBound proves the numeric bounds
// refuse a malformed value rather than silently dropping it.
func TestGetOutboxRefusesANonPositiveIntegerBound(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/outbox?limit=abc")

	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — a malformed limit must not be silently dropped: %s", got.status, got.raw)
	}
}

// TestGetOutboxOmitsUnsetFiltersFromTheFederatedRequest proves an absent
// filter is left off the request entirely, so the product applies its own
// default rather than platform-api inventing one.
func TestGetOutboxOmitsUnsetFiltersFromTheFederatedRequest(t *testing.T) {
	a := serve(t)

	if got := a.get("/v1/outbox"); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}

	asked := <-a.asked
	if asked != "/admin/outbox" {
		t.Errorf("product was asked for %q, want /admin/outbox with no query string when the caller sent no filters", asked)
	}
}
