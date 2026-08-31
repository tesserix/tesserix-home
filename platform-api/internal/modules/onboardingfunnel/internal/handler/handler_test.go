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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/onboardingfunnel"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
	productSlug     = "mark8ly"
	route           = "/v1/onboarding/funnel"
)

// The funnel as mark8ly serves it today: counters at the root, the nullable
// median, the narrower last_24h, and the effective window.
const liveFunnel = `{"data":{` +
	`"started":140,"email_verified":96,"completed":61,"in_flight":22,"abandoned":57,` +
	`"median_completion_seconds":812.5,` +
	`"last_24h":{"started":9,"completed":4},` +
	`"window":{"from":"2026-08-01T00:00:00Z","to":"2026-08-30T00:00:00Z"}}}`

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
	return serveProduct(t, http.StatusOK, liveFunnel, []string{productSlug})
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
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret",
			Endpoints: []string{"onboarding"}},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor("platform")}, projectID)
	httpx.RegisterModule(mux, verifier, "onboardingfunnel", func(m *http.ServeMux) {
		onboardingfunnel.Register(m, onboardingfunnel.Config{
			Fed: fed, Slugs: slugs, Verifier: verifier, Log: log,
		})
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

func TestFunnelReturnsTheProductsCounts(t *testing.T) {
	got := serve(t).get(route + "?source=" + productSlug)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data, _ := got.body["data"].(map[string]any)
	if data["started"] != float64(140) || data["email_verified"] != float64(96) {
		t.Errorf("data = %v, want mark8ly's own counters", data)
	}
}

// Rule 1: mark8ly's stage vocabulary reaches the console verbatim, including a
// stage this service has never heard of.
func TestFunnelRendersTheProductsVocabularyVerbatim(t *testing.T) {
	a := serveProduct(t, http.StatusOK, `{"data":{"started":3,"payment_attached":2,`+
		`"median_completion_seconds":null,"last_24h":{"started":1,"completed":0},`+
		`"window":{"from":"a","to":"b"}}}`, []string{productSlug})
	got := a.get(route + "?source=" + productSlug)
	if !strings.Contains(got.raw, `"payment_attached":2`) {
		t.Errorf("body = %s, want the unknown stage carried through", got.raw)
	}
}

// THE assertion this module exists for. An unmeasurable median must arrive at
// the console as an explicit null — a distinct, representable state — and
// never as 0, which renders as "instant completion" for a funnel nobody
// finished. This test fails the moment the two collapse.
func TestFunnelKeepsAnUnmeasurableMedianDistinctFromZero(t *testing.T) {
	body := strings.Replace(liveFunnel, `"median_completion_seconds":812.5`,
		`"median_completion_seconds":null`, 1)
	got := serveProduct(t, http.StatusOK, body, []string{productSlug}).
		get(route + "?source=" + productSlug)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data, _ := got.body["data"].(map[string]any)
	value, present := data["median_completion_seconds"]
	if !present {
		t.Fatal("median_completion_seconds is missing; an absent key is what a `?? 0` turns into zero")
	}
	if value != nil {
		t.Fatalf("median = %#v, want an explicit null", value)
	}
	if !strings.Contains(got.raw, `"median_completion_seconds":null`) {
		t.Errorf("body = %s, want a literal JSON null on the wire", got.raw)
	}
}

// "A stage with zero is a measurement; a funnel that could not be read is
// not." Every unreadable answer must reach the console as a status it cannot
// mistake for data — never a 200 with an empty or absent funnel.
func TestFunnelNeverRendersAnUnreadableAnswerAsAFunnel(t *testing.T) {
	for name, upstream := range map[string]struct {
		status int
		body   string
	}{
		"empty funnel object": {http.StatusOK, `{"data":{}}`},
		"null funnel":         {http.StatusOK, `{"data":null}`},
		"no median key":       {http.StatusOK, `{"data":{"started":1,"completed":0}}`},
		"outage":              {http.StatusBadGateway, `{"error":"boom"}`},
		"garbage":             {http.StatusOK, `not json`},
	} {
		t.Run(name, func(t *testing.T) {
			got := serveProduct(t, upstream.status, upstream.body, []string{productSlug}).
				get(route + "?source=" + productSlug)
			if got.status == http.StatusOK {
				t.Fatalf("status = 200 for an unreadable funnel: %s", got.raw)
			}
			if _, present := got.body["data"]; present {
				t.Errorf("a failed read carried a `data` key: %s", got.raw)
			}
		})
	}
}

// An outage is not a contract statement, and must not be reported as one.
func TestFunnelReportsAnOutageAsUnavailableNotAsMissing(t *testing.T) {
	got := serveProduct(t, http.StatusBadGateway, `{"error":"boom"}`, []string{productSlug}).
		get(route + "?source=" + productSlug)
	for _, wrong := range []int{http.StatusNotImplemented, http.StatusNotFound} {
		if got.status == wrong {
			t.Fatalf("an outage was reported as %d: %s", wrong, got.raw)
		}
	}
	if got.status != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503: %s", got.status, got.raw)
	}
}

// 404 and 501 are different answers from the product and stay distinguishable
// through the hop: "declared but not mounted" versus "mounted and declining".
func TestFunnel404And501StayDistinct(t *testing.T) {
	a := serveProduct(t, http.StatusNotFound, `{"error":"not_found"}`, []string{productSlug})
	if got := a.get(route + "?source=" + productSlug); got.status != http.StatusNotFound {
		t.Errorf("404: status = %d, want 404 carried through: %s", got.status, got.raw)
	}
	b := serveProduct(t, http.StatusNotImplemented, `{"error":"not_implemented"}`, []string{productSlug})
	if got := b.get(route + "?source=" + productSlug); got.status != http.StatusNotImplemented {
		t.Errorf("501: status = %d, want 501 carried through: %s", got.status, got.raw)
	}
}

// Merging two products' funnels needs a third vocabulary that is neither
// product's — exactly what #404's first rule forbids.
func TestFunnelRequiresASource(t *testing.T) {
	if got := serve(t).get(route); got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

func TestFunnelRejectsUnknownSourceAndParameters(t *testing.T) {
	a := serve(t)
	if got := a.get(route + "?source=nosuch"); got.status != http.StatusBadRequest {
		t.Errorf("unknown source: status = %d, want 400", got.status)
	}
	if got := a.get(route + "?source=" + productSlug + "&status=abandoned"); got.status != http.StatusBadRequest {
		t.Errorf("unknown param: status = %d, want 400", got.status)
	}
}

// The window parameters mark8ly reads are accepted and forwarded.
func TestFunnelAcceptsTheWindowParameters(t *testing.T) {
	got := serve(t).get(route + "?source=" + productSlug +
		"&created_from=2026-08-01T00:00:00Z&created_to=2026-08-30T00:00:00Z")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
}

// "No product declares an onboarding funnel" is a deployment fact, not an
// outage and not an empty funnel.
func TestFunnelIsNotImplementedWhenNoProductDeclaresOne(t *testing.T) {
	a := serveProduct(t, http.StatusOK, liveFunnel, nil)
	if got := a.get(route + "?source=" + productSlug); got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
}
