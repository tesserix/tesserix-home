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
	// asked receives the URL the stand-in product was called with.
	asked chan string
}

// serve builds an api with an operator holding `platform`, the capability
// this module gates its one route on.
func serve(t *testing.T) *api { t.Helper(); return serveAs(t, "platform") }

// serveAs mounts the module behind httpx.RegisterModule and httpx.WithMiddleware
// — exactly what cmd/server composes — with a product server standing in for
// mark8ly's /admin/audit-logs endpoint, returning one row.
func serveAs(t *testing.T, roles ...string) *api {
	t.Helper()
	return serveSlugs(t, []string{productSlug}, roles...)
}

// serveNoProducts mounts the same module with an EMPTY registry: the shape a
// deployment has before FEDERATION_PRODUCTS is set.
func serveNoProducts(t *testing.T) *api {
	t.Helper()
	return serveSlugs(t, nil, "platform")
}

// serveSlugs is the composition both of the above share. The stand-in product
// records the URL it was asked for, so a test can assert on the query the
// handler forwarded.
func serveSlugs(t *testing.T, slugs []string, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	asked := make(chan string, 4)
	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked <- r.URL.String()
		_, _ = w.Write([]byte(`{"data":[{"id":"1","action":"tenant.suspended","timestamp":"2026-08-22T10:00:00Z"}]}`))
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

// TestGetAuditWithNoConfiguredProductsIsFiveOhOne is I2's guard at the HTTP
// surface. Before the fix an empty registry fanned out to nothing and answered
// 200 with an empty timeline, so a misconfigured deployment was
// indistinguishable from a quiet estate — and the console's
// `instrumentation-unavailable` state, which reads exactly this status, could
// never be reached on this transport.
func TestGetAuditWithNoConfiguredProductsIsFiveOhOne(t *testing.T) {
	a := serveNoProducts(t)

	got := a.get("/v1/audit")

	if got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501 — an unconfigured registry must not read as 'nothing happened': %s", got.status, got.raw)
	}
	if strings.Contains(got.raw, `"entries"`) {
		t.Errorf("body = %s, want no entries key: an empty timeline is the very claim this status refuses to make", got.raw)
	}
}

// The bounds are DEFAULTED, not omitted, so a direct API caller is given the
// same window the console asks for rather than an unbounded read the
// federation client truncates at 1 MiB.
func TestGetAuditDefaultsTheBoundsEachProductIsAskedFor(t *testing.T) {
	a := serve(t)

	if got := a.get("/v1/audit"); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}

	asked := <-a.asked
	if !strings.Contains(asked, "limit=200") || !strings.Contains(asked, "since_hours=720") {
		t.Errorf("product was asked for %q, want limit=200 and since_hours=720", asked)
	}
}

func TestGetAuditForwardsTheBoundsItWasGiven(t *testing.T) {
	a := serve(t)

	if got := a.get("/v1/audit?limit=5&since_hours=24"); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}

	asked := <-a.asked
	if !strings.Contains(asked, "limit=5") || !strings.Contains(asked, "since_hours=24") {
		t.Errorf("product was asked for %q, want the caller's limit=5 and since_hours=24", asked)
	}
}

// Junk is refused rather than coerced: a silently defaulted `?limit=abc` is a
// truncated audit timeline nobody was told about, which is the same class of
// lie as an unknown `?source=` returning zero rows.
//
// Asserted against the EXACT status, not just "some 4xx": readBound used to
// answer 422 via httpx.Validation while its own comment promised 400, and a
// loose 4xx-range assertion is exactly what let that drift ship unnoticed.
// httpx.RejectUnknownParameters, on the same handler, has always answered
// 400 for a malformed query — one surface must not answer two shapes for one
// concern.
func TestGetAuditRefusesBoundsItCannotRead(t *testing.T) {
	for _, query := range []string{
		"?limit=abc",
		"?limit=0",
		"?limit=-1",
		"?since_hours=soon",
		"?since_hours=0",
		"?window=7d",
	} {
		t.Run(query, func(t *testing.T) {
			got := serve(t).get("/v1/audit" + query)
			if got.status != http.StatusBadRequest {
				t.Fatalf("GET /v1/audit%s = %d, want 400: %s", query, got.status, got.raw)
			}
			if strings.Contains(got.raw, `"entries"`) {
				t.Errorf("body = %s, want no entries key on a refusal", got.raw)
			}
		})
	}
}

// The handler mirrors apps/web's own maximums (MAX_LIMIT and
// MAX_SINCE_HOURS) so `?limit=1000000` cannot fan out to every product
// unbounded and hit the federation client's 1 MiB read cap. Unlike
// apps/web, which clamps silently, this handler refuses — see the comment
// on MaxLimit/MaxSinceHours in handler.go for why that divergence is
// deliberate.
func TestGetAuditRefusesBoundsAboveTheMaximum(t *testing.T) {
	for _, tc := range []struct {
		query string
		name  string
	}{
		{"?limit=1001", "limit"},
		{"?since_hours=721", "since_hours"},
	} {
		t.Run(tc.query, func(t *testing.T) {
			got := serve(t).get("/v1/audit" + tc.query)
			if got.status != http.StatusBadRequest {
				t.Fatalf("GET /v1/audit%s = %d, want 400: %s", tc.query, got.status, got.raw)
			}
			if !strings.Contains(got.raw, tc.name) {
				t.Errorf("body = %s, want the offending parameter %q named", got.raw, tc.name)
			}
			if strings.Contains(got.raw, `"entries"`) {
				t.Errorf("body = %s, want no entries key on a refusal", got.raw)
			}
		})
	}
}

// The maximums themselves are still accepted — this is a boundary test, not
// an off-by-one: 1000 and 720 are apps/web's own MAX_LIMIT and
// MAX_SINCE_HOURS, and they are exactly what the console sends today via
// AUDIT_LIMIT/AUDIT_SINCE_HOURS.
func TestGetAuditAcceptsBoundsAtExactlyTheMaximum(t *testing.T) {
	a := serve(t)

	if got := a.get("/v1/audit?limit=1000&since_hours=720"); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 at the exact maximum: %s", got.status, got.raw)
	}

	asked := <-a.asked
	if !strings.Contains(asked, "limit=1000") || !strings.Contains(asked, "since_hours=720") {
		t.Errorf("product was asked for %q, want limit=1000 and since_hours=720", asked)
	}
}

// The whole point of I1, asserted through the real router: the row a product
// serves with a bare id reaches the console namespaced with the product that
// served it, exactly as apps/web's producer has always emitted it.
func TestGetAuditNamespacesRowIdsWithTheirSource(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/audit").data(t)

	entries, _ := got["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %v, want 1", got["entries"])
	}
	first, _ := entries[0].(map[string]any)
	if first["id"] != productSlug+":1" {
		t.Errorf("id = %v, want %q — a bare id collides with any other product's integer keys", first["id"], productSlug+":1")
	}
}
