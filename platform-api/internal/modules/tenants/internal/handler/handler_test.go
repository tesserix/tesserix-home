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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tenants"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// Exercised through the REAL router, the real verifier and an httptest product
// standing in for mark8ly. Only the token's signature is faked.

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
	asked   chan string
}

func serve(t *testing.T) *api { t.Helper(); return serveSlugs(t, []string{productSlug}, "platform") }

func serveNoProducts(t *testing.T) *api { t.Helper(); return serveSlugs(t, nil, "platform") }

func serveSlugs(t *testing.T, slugs []string, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	asked := make(chan string, 4)
	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked <- r.URL.String()
		// The lifecycle verbs answer a DIFFERENT envelope from the directory
		// read — `{data: {...}}` rather than `{data: [...], pagination}`. A
		// stub that returned the list for every path would make a write look
		// like a decode failure, which is how the first run of these tests
		// reported a 503 for a request that had actually reached the product.
		// §8.8 answers a third envelope again — `{data: {verb: [...]}}` — so
		// it needs its own branch for the same reason the writes do.
		if strings.HasSuffix(r.URL.Path, "/lifecycle/reason-codes") {
			_, _ = w.Write([]byte(`{"data":{"suspend":[{"code":"fraud","label":"Fraud"}],"unsuspend":[{"code":"resolved","label":"Resolved"}]}}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/suspend") || strings.HasSuffix(r.URL.Path, "/unsuspend") {
			_, _ = w.Write([]byte(`{"data":{"tenant_id":"t1","status":"suspended","stores_affected":3,"changed":true}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"t1","name":"Acme","owner_email":"a@x.test","status":"active","created_at":"2026-08-12T09:31:00Z"}],"pagination":{"page":1,"limit":50,"total":1}}`))
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret"},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	httpx.RegisterModule(mux, verifier, "tenants", func(m *http.ServeMux) {
		tenants.Register(m, tenants.Config{
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

func TestGetTenantsReturnsTenantsAndFailuresAsArrays(t *testing.T) {
	a := serve(t)
	data := a.get("/v1/tenants").data(t)

	// Both keys must be present and be arrays even when empty: a nil slice
	// serialises as null, which defeats the console's `?? []`.
	if _, ok := data["tenants"].([]any); !ok {
		t.Errorf("tenants is not an array: %v", data["tenants"])
	}
	if _, ok := data["failures"].([]any); !ok {
		t.Errorf("failures is not an array: %v", data["failures"])
	}
}

func TestGetTenantsNamespacesIdsAndStampsTheSource(t *testing.T) {
	a := serve(t)
	rows, _ := a.get("/v1/tenants").data(t)["tenants"].([]any)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	row, _ := rows[0].(map[string]any)
	if row["id"] != "mark8ly:t1" {
		t.Errorf("id = %v, want mark8ly:t1", row["id"])
	}
	if row["source"] != "mark8ly" {
		t.Errorf("source = %v, want mark8ly", row["source"])
	}
}

func TestGetTenantsForwardsTheSearchAndBoundsToTheProduct(t *testing.T) {
	a := serve(t)
	a.get("/v1/tenants?q=acme&status=active&limit=25")
	select {
	case asked := <-a.asked:
		for _, want := range []string{"q=acme", "status=active", "limit=25"} {
			if !strings.Contains(asked, want) {
				t.Errorf("product was asked %q, missing %q", asked, want)
			}
		}
	default:
		t.Fatal("the product was never called")
	}
}

func TestGetTenantsDefaultsTheBoundTheProductIsAskedFor(t *testing.T) {
	a := serve(t)
	a.get("/v1/tenants")
	select {
	case asked := <-a.asked:
		if !strings.Contains(asked, "limit=100") {
			t.Errorf("product was asked %q, want the default limit=100", asked)
		}
	default:
		t.Fatal("the product was never called")
	}
}

// An unknown source is a 400, not an empty 200: a typo must not read as "that
// product has no tenants".
func TestGetTenantsWithAnUnknownSourceIsFourHundred(t *testing.T) {
	a := serve(t)
	got := a.get("/v1/tenants?source=nope")
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
	if _, present := got.body["data"]; present {
		if data, ok := got.body["data"].(map[string]any); ok && data["tenants"] != nil {
			t.Error("a refusal must not carry a tenants key")
		}
	}
}

// An unconfigured deployment must not be able to impersonate "no tenants".
func TestGetTenantsWithNoConfiguredProductsIsFiveOhOne(t *testing.T) {
	a := serveNoProducts(t)
	got := a.get("/v1/tenants")
	if got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
}

func TestGetTenantsRejectsAnUnknownParameter(t *testing.T) {
	a := serve(t)
	got := a.get("/v1/tenants?sourc=mark8ly")
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a typo'd parameter: %s", got.status, got.raw)
	}
}

func TestGetTenantsRejectsABadLimitRatherThanDefaultingIt(t *testing.T) {
	a := serve(t)
	for _, bad := range []string{"abc", "0", "-5", "100000"} {
		got := a.get("/v1/tenants?limit=" + bad)
		if got.status != http.StatusBadRequest {
			t.Errorf("limit=%s = %d, want 400", bad, got.status)
		}
	}
}

func TestGetTenantsWithoutPlatformIsFourOhThree(t *testing.T) {
	a := serveSlugs(t, []string{productSlug}, "support")
	got := a.get("/v1/tenants")
	if got.status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", got.status, got.raw)
	}
}

func TestGetTenantsWithNoAuthorizationHeaderIsFourOhOne(t *testing.T) {
	a := serve(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/tenants", nil)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
