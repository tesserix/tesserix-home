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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/entities"
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
	asked   chan string
}

func serve(t *testing.T) *api {
	t.Helper()
	return serveTypes(t, map[string][]string{productSlug: {"users", "foods"}})
}

func serveTypes(t *testing.T, types map[string][]string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	asked := make(chan string, 4)
	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked <- r.URL.String()
		_, _ = w.Write([]byte(`{"data":[{"id":"528ea893","type":"foods","label":"Veg kolhapuri","created_at":"2026-08-22T07:16:52Z"}],"pagination":{"page":1,"limit":100,"total":6421}}`))
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret"},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor("platform")}, projectID)
	httpx.RegisterModule(mux, verifier, "entities", func(m *http.ServeMux) {
		entities.Register(m, entities.Config{Fed: fed, Types: types, Verifier: verifier, Log: log})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t, asked: asked}
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

func TestEntitiesReturnsRecordsAndPagination(t *testing.T) {
	got := serve(t).get("/v1/entities/foods?source=" + productSlug)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data, _ := got.body["data"].(map[string]any)
	rows, _ := data["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows = %v: %s", data["data"], got.raw)
	}
	pagination, _ := data["pagination"].(map[string]any)
	if pagination["total"] != float64(6421) {
		t.Errorf("total = %v, want the product's own count", pagination["total"])
	}
}

// Browse is the contract's shape now (§3.4, kora#480). A request with no `q`
// must reach the product without one, not with `q=`.
func TestEntitiesBrowsesWhenNoSearchIsGiven(t *testing.T) {
	a := serve(t)
	if got := a.get("/v1/entities/foods?source=" + productSlug); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	select {
	case url := <-a.asked:
		if strings.Contains(url, "q=") {
			t.Errorf("product asked %q; an absent search must not be sent as q=", url)
		}
	default:
		t.Fatal("the product was never called")
	}
}

func TestEntitiesForwardsASearch(t *testing.T) {
	a := serve(t)
	a.get("/v1/entities/foods?source=" + productSlug + "&q=ri")
	select {
	case url := <-a.asked:
		if !strings.Contains(url, "q=ri") {
			t.Errorf("product asked %q, want q=ri", url)
		}
	default:
		t.Fatal("the product was never called")
	}
}

// Merging two products' `users` makes a table whose columns mean different
// things per row.
func TestEntitiesRequiresASource(t *testing.T) {
	if got := serve(t).get("/v1/entities/foods"); got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// An undeclared type is refused here rather than becoming the product's 404,
// which would read as an outage.
//
// 501 rather than 400 (#546): the request was well formed and the console
// built it from its own rail — the type is simply not among this deployment's
// FEDERATION_<SLUG>_ENTITIES, which is a configuration state, not a mistake by
// the caller.
func TestEntitiesRefusesAnUndeclaredType(t *testing.T) {
	got := serve(t).get("/v1/entities/tenants?source=" + productSlug)
	if got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
	// And says WHICH mistake it was, so whoever hit it checks the right thing.
	if !strings.Contains(got.raw, "tenants") {
		t.Errorf("message does not name the type: %s", got.raw)
	}
}

// THE regression this issue is about (#546). A product this deployment does
// not federate must not read as a hard failure: it is not switched on here,
// and the console renders 501 calmly and 400 as an outage.
//
// Asserted as 501 EXACTLY, not as "not 400": the two causes were collapsed
// before, and a test that only rules the old status out would pass under any
// replacement, including one the console still renders as breakage.
func TestEntitiesReportsAnUnfederatedProductAsNotImplemented(t *testing.T) {
	got := serve(t).get("/v1/entities/foods?source=mark8ly")
	if got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
	if !strings.Contains(got.raw, "mark8ly") {
		t.Errorf("message does not name the slug asked for: %s", got.raw)
	}
}

// The three refusals are one status and three MESSAGES. Collapsing the
// messages is what sends whoever hit it to check the wrong thing, so each is
// pinned separately here — the status alone cannot tell them apart, which is
// exactly why the text has to.
func TestEntitiesKeepsItsRefusalsDistinct(t *testing.T) {
	federated := serve(t)
	unknownSource := federated.get("/v1/entities/foods?source=kroa")
	typeNotServed := federated.get("/v1/entities/tenants?source=" + productSlug)
	nothingFederated := serveTypes(t, nil).get("/v1/entities/foods?source=" + productSlug)

	for _, tc := range []struct {
		name string
		got  response
		want string
	}{
		{"unknown source", unknownSource, "unknown source"},
		{"type not served", typeNotServed, "does not serve"},
		{"nothing federated", nothingFederated, "no products are configured"},
	} {
		if tc.got.status != http.StatusNotImplemented {
			t.Errorf("%s: status = %d, want 501: %s", tc.name, tc.got.status, tc.got.raw)
		}
		if !strings.Contains(tc.got.raw, tc.want) {
			t.Errorf("%s: message %s does not contain %q", tc.name, tc.got.raw, tc.want)
		}
	}
	// And they really are three different sentences, not one status wearing
	// three names.
	if unknownSource.raw == typeNotServed.raw || unknownSource.raw == nothingFederated.raw ||
		typeNotServed.raw == nothingFederated.raw {
		t.Errorf("two refusals carry the same message:\n%s\n%s\n%s",
			unknownSource.raw, typeNotServed.raw, nothingFederated.raw)
	}
}

// A MALFORMED request is still a 400. That is the meaning 400 keeps, and it is
// what stops the change above from turning the route into one that never
// refuses a caller.
func TestEntitiesRejectsMalformedRequests(t *testing.T) {
	a := serve(t)
	if got := a.get("/v1/entities/foods?source=" + productSlug + "&sort=name"); got.status != http.StatusBadRequest {
		t.Errorf("unknown param: status = %d, want 400", got.status)
	}
	if got := a.get("/v1/entities/foods?source=" + productSlug + "&limit=abc"); got.status != http.StatusBadRequest {
		t.Errorf("limit=abc: status = %d, want 400", got.status)
	}
	// Refused, not clamped: silently returning fewer rows than asked for is
	// how a caller comes to believe a page is complete when it is not.
	if got := a.get("/v1/entities/foods?source=" + productSlug + "&limit=99999"); got.status != http.StatusBadRequest {
		t.Errorf("oversized limit: status = %d, want 400", got.status)
	}
}

func TestEntitiesIsNotImplementedWhenNothingIsConfigured(t *testing.T) {
	if got := serveTypes(t, nil).get("/v1/entities/foods?source=" + productSlug); got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
}

func TestEntitiesForwardsThePage(t *testing.T) {
	a := serve(t)
	a.get("/v1/entities/foods?source=" + productSlug + "&page=4")
	select {
	case url := <-a.asked:
		if !strings.Contains(url, "page=4") {
			t.Errorf("product asked %q, want page=4", url)
		}
	default:
		t.Fatal("the product was never called")
	}
}

// `?page=0` and `?page=-1` are bugs in whatever built the link. Answering them
// with page 1 hides a pager that has walked off the start of its range.
func TestEntitiesRefusesANonPositivePage(t *testing.T) {
	a := serve(t)
	for _, raw := range []string{"0", "-1", "abc"} {
		if got := a.get("/v1/entities/foods?source=" + productSlug + "&page=" + raw); got.status != http.StatusBadRequest {
			t.Errorf("page=%s: status = %d, want 400", raw, got.status)
		}
	}
}
