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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/kpis"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
	productSlug     = "kora"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:  subjectOperator,
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
	return serveProduct(t, http.StatusOK, `{"data":{"users_active":412}}`, []string{productSlug})
}

// serveProduct mounts the module through httpx.RegisterModule — what
// cmd/server composes — over a product answering the given status and body.
func serveProduct(t *testing.T, status int, body string, slugs []string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret"},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor("platform")}, projectID)
	httpx.RegisterModule(mux, verifier, "kpis", func(m *http.ServeMux) {
		kpis.Register(m, kpis.Config{Fed: fed, Slugs: slugs, Verifier: verifier, Log: log})
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

func TestKpisReturnsTheProductsMetrics(t *testing.T) {
	got := serve(t).get("/v1/kpis?source=" + productSlug)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data, _ := got.body["data"].(map[string]any)
	if data["users_active"] != float64(412) {
		t.Errorf("data = %v, want the product's own numbers", data)
	}
}

// THE assertion this module exists for. A 501 from the product must arrive at
// the console as a 501, so `instrumentation-unavailable` fires and the page
// renders "not instrumented" rather than dashes an operator reads as zeroes.
func TestKpis501SurvivesTheHop(t *testing.T) {
	a := serveProduct(t, http.StatusNotImplemented,
		`{"error":"not_implemented","message":"kora does not report business KPIs yet"}`,
		[]string{productSlug})
	if got := a.get("/v1/kpis?source=" + productSlug); got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501 carried through: %s", got.status, got.raw)
	}
}

// The dangerous inversion: an unreachable product must not be reported as
// having no metrics.
func TestKpisReportsAnOutageAsUnavailableNotAsMissing(t *testing.T) {
	a := serveProduct(t, http.StatusBadGateway, `{"error":"boom"}`, []string{productSlug})
	got := a.get("/v1/kpis?source=" + productSlug)
	if got.status == http.StatusNotImplemented {
		t.Fatalf("an outage was reported as 501 not-instrumented: %s", got.raw)
	}
	if got.status != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503: %s", got.status, got.raw)
	}
}

// Merging two products' headline numbers produces a figure describing nothing.
func TestKpisRequiresASource(t *testing.T) {
	if got := serve(t).get("/v1/kpis"); got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// THE regression this issue is about (#546). A product this deployment does
// not federate is not a bad request: the console navigates there from its own
// rail, and the honest answer is "not switched on here" — the state 501 gets
// rendered as, where 400 renders as an outage.
//
// Asserted as 501 EXACTLY rather than as "not 400": this status was carrying
// two collapsed causes, and a test that merely rules the old value out passes
// under replacements the console still renders as breakage.
func TestKpisReportsAnUnfederatedProductAsNotImplemented(t *testing.T) {
	got := serve(t).get("/v1/kpis?source=mark8ly")
	if got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
	if !strings.Contains(got.raw, "mark8ly") {
		t.Errorf("message does not name the slug asked for: %s", got.raw)
	}
}

// Three causes now answer 501 and each keeps its OWN message — the status
// cannot tell them apart, so the text has to.
func TestKpisKeepsIts501CausesDistinct(t *testing.T) {
	unknownSource := serve(t).get("/v1/kpis?source=kroa")
	noProducts := serveProduct(t, http.StatusOK, `{"data":{"n":1}}`, nil).
		get("/v1/kpis?source=" + productSlug)
	notInstrumented := serveProduct(t, http.StatusNotImplemented,
		`{"error":"not_implemented"}`, []string{productSlug}).
		get("/v1/kpis?source=" + productSlug)

	for _, tc := range []struct {
		name string
		got  response
		want string
	}{
		{"unknown source", unknownSource, "unknown source"},
		{"no products", noProducts, "no products are configured"},
		{"not instrumented", notInstrumented, "no headline metrics"},
	} {
		if tc.got.status != http.StatusNotImplemented {
			t.Errorf("%s: status = %d, want 501: %s", tc.name, tc.got.status, tc.got.raw)
		}
		if !strings.Contains(tc.got.raw, tc.want) {
			t.Errorf("%s: message %s does not contain %q", tc.name, tc.got.raw, tc.want)
		}
	}
	if unknownSource.raw == noProducts.raw || unknownSource.raw == notInstrumented.raw ||
		noProducts.raw == notInstrumented.raw {
		t.Errorf("two refusals carry the same message:\n%s\n%s\n%s",
			unknownSource.raw, noProducts.raw, notInstrumented.raw)
	}
}

// A product answering `{}` was REACHED. Reporting it as "could not be reached"
// sends an operator to check a network path that is fine, when the thing to
// fix is the product's §3.1 deviation.
//
// Still a 503 — the read cannot be served either way — but under its own code
// and its own sentence. The code is what the assertion turns on, because the
// status alone is what was already wrong.
func TestKpisReportsAnEmptyMetricsMapAsTheProductsDeviation(t *testing.T) {
	got := serveProduct(t, http.StatusOK, `{"data":{}}`, []string{productSlug}).
		get("/v1/kpis?source=" + productSlug)
	if got.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", got.status, got.raw)
	}
	if code := errorCode(t, got); code != httpx.CodeExternalService {
		t.Errorf("code = %q, want %q: %s", code, httpx.CodeExternalService, got.raw)
	}
	if strings.Contains(got.raw, "could not be reached") {
		t.Errorf("a reachable product was reported as unreachable: %s", got.raw)
	}
}

// The other 503, kept apart from it by code alone.
func TestKpisReportsAnOutageUnderTheUnavailableCode(t *testing.T) {
	got := serveProduct(t, http.StatusBadGateway, `{"error":"boom"}`, []string{productSlug}).
		get("/v1/kpis?source=" + productSlug)
	if got.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", got.status, got.raw)
	}
	if code := errorCode(t, got); code != httpx.CodeUnavailable {
		t.Errorf("code = %q, want %q: %s", code, httpx.CodeUnavailable, got.raw)
	}
}

// errorCode reads `error.code` out of the StandardResponse envelope.
func errorCode(t *testing.T, got response) string {
	t.Helper()
	envelope, ok := got.body["error"].(map[string]any)
	if !ok {
		t.Fatalf("response carries no error object: %s", got.raw)
	}
	code, _ := envelope["code"].(string)
	return code
}

// A MALFORMED request is still a 400 — the meaning 400 keeps.
func TestKpisRejectsMalformedRequests(t *testing.T) {
	a := serve(t)
	if got := a.get("/v1/kpis?source=" + productSlug + "&window=7d"); got.status != http.StatusBadRequest {
		t.Errorf("unknown param: status = %d, want 400", got.status)
	}
}

func TestKpisIsNotImplementedWhenNoProductsAreConfigured(t *testing.T) {
	a := serveProduct(t, http.StatusOK, `{"data":{"n":1}}`, nil)
	if got := a.get("/v1/kpis?source=" + productSlug); got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
}
