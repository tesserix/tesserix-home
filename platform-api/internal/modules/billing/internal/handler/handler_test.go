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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

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
		Subject:  subjectOperator,
		Audience: []string{projectID}, Issuer: "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour), Roles: roles,
	}
}

// call is one request the stub product received. The whole request and not
// just its URL, because a write is only right if its method, body and
// Idempotency-Key are.
type call struct {
	method  string
	url     string
	body    string
	headers http.Header
}

type api struct {
	handler http.Handler
	t       *testing.T
	calls   chan call
}

const subsBody = `{"data":[{"tenant_id":"t1","tenant_name":"Acme","plan":"pro","status":"active","amount":{"amount":4900,"currency":"AUD"},"current_period_end":"2026-09-30T00:00:00Z"}],"pagination":{"page":1,"limit":100,"total":37}}`
const discountBody = `{"tenant_id":"11111111-1111-1111-1111-111111111111","coupon_id":"LOYAL20","operation":"apply","reason":"goodwill after the outage","performed_at":"2026-09-06T10:00:00Z","status":"partial","requires_reconciliation":true,"stores":[{"store_id":"s1","subscription_id":"sub1","stripe_customer_id":"cus_1","stripe_subscription_id":"sub_stripe_1","outcome":"applied"},{"store_id":"s2","outcome":"failed","failure_code":"stripe_changed_audit_write_failed","failure_reason":"stripe accepted the discount change but the audit row was not written"}]}`

const trialsBody = `{"data":[{"tenant_id":"t3","trial_ends_at":"2026-09-10T00:00:00Z","days_remaining":9,"plan":"pro","payment_method_on_file":false,"status":"trialing"}],"pagination":{"page":1,"limit":100,"total":5}}`

// serve mounts the module with an operator holding BOTH capabilities this
// module gates on: `billing` — the surface, and the first route in the estate
// to use it — and `publish-catalog`, which only the discount writes require.
// The single-capability cases are asserted in discount_test.go.
func serve(t *testing.T) *api {
	t.Helper()
	return serveAs(t, []string{productSlug}, "billing", "publish-catalog")
}

func serveNoProducts(t *testing.T) *api {
	t.Helper()
	return serveAs(t, nil, "billing", "publish-catalog")
}

func serveAs(t *testing.T, slugs []string, roles ...string) *api {
	t.Helper()
	return serveProduct(t, http.HandlerFunc(defaultProduct), slugs, roles...)
}

// defaultProduct answers each of the module's federated paths with a body in
// mark8ly's own shape. The discount report is deliberately NOT wrapped in a
// `data` envelope, because mark8ly's handler does not wrap it.
func defaultProduct(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.Contains(r.URL.Path, "/discount"):
		_, _ = w.Write([]byte(discountBody))
	case strings.Contains(r.URL.Path, "trials"):
		_, _ = w.Write([]byte(trialsBody))
	default:
		_, _ = w.Write([]byte(subsBody))
	}
}

func serveProduct(t *testing.T, upstream http.Handler, slugs []string, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	calls := make(chan call, 8)
	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls <- call{method: r.Method, url: r.URL.String(), body: string(body), headers: r.Header.Clone()}
		upstream.ServeHTTP(w, r)
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret"},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	httpx.RegisterModule(mux, verifier, "billing", func(m *http.ServeMux) {
		billing.Register(m, billing.Config{Fed: fed, Slugs: slugs, Verifier: verifier, Log: log})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t, calls: calls}
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
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a *api) get(path string) response {
	a.t.Helper()
	return a.do(http.MethodGet, path, "", nil)
}

// post is a write with the Idempotency-Key the routes require, so a test that
// means to exercise something else does not accidentally assert the key check.
func (a *api) post(path, body string) response {
	a.t.Helper()
	return a.do(http.MethodPost, path, body, map[string]string{"Idempotency-Key": "k-1"})
}

// lastCall drains what the product received. The absence of any call is the
// half a status code cannot show: a write refused AFTER it reached the product
// has already happened.
func (a *api) lastCall() (call, bool) {
	a.t.Helper()
	var last call
	var seen bool
	for {
		select {
		case c := <-a.calls:
			last, seen = c, true
		default:
			return last, seen
		}
	}
}

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

func TestSubscriptionsAndTrialsBothAnswer(t *testing.T) {
	a := serve(t)
	for _, path := range []string{"/v1/billing/subscriptions", "/v1/billing/trials"} {
		got := a.get(path)
		if got.status != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200: %s", path, got.status, got.raw)
		}
		data := got.data(t)
		if _, ok := data["data"].([]any); !ok {
			t.Errorf("%s: data is not an array: %v", path, data["data"])
		}
		if _, ok := data["failures"].([]any); !ok {
			t.Errorf("%s: failures is not an array: %v", path, data["failures"])
		}
	}
}

// §4.2 through the whole hop: minor units with a currency, never a bare number.
func TestSubscriptionMoneyKeepsItsCurrency(t *testing.T) {
	data := serve(t).get("/v1/billing/subscriptions").data(t)
	rows, _ := data["data"].([]any)
	row, _ := rows[0].(map[string]any)
	amount, ok := row["amount"].(map[string]any)
	if !ok {
		t.Fatalf("amount is not an object: %v", row["amount"])
	}
	if amount["amount"] != float64(4900) || amount["currency"] != "AUD" {
		t.Errorf("amount = %v, want minor units with an explicit currency", amount)
	}
}

// THE assertion that makes `billing` more than decoration. `platform` is the
// capability every other Operate read uses, and it must NOT open this one.
func TestAPlatformOperatorCannotReadBilling(t *testing.T) {
	a := serveAs(t, []string{productSlug}, "platform")
	for _, path := range []string{"/v1/billing/subscriptions", "/v1/billing/trials"} {
		if got := a.get(path); got.status != http.StatusForbidden {
			t.Errorf("%s with platform = %d, want 403: %s", path, got.status, got.raw)
		}
	}
}

func TestTrialsForwardTheStripeManagedOptIn(t *testing.T) {
	a := serve(t)
	a.get("/v1/billing/trials?include_stripe_managed=true")
	got, called := a.lastCall()
	if !called {
		t.Fatal("the product was never called")
	}
	if !strings.Contains(got.url, "include_stripe_managed=true") {
		t.Errorf("product asked %q, want the opt-in forwarded", got.url)
	}
}

// A widening flag: the safe reading of an unrecognised value is the narrower
// result, so anything but `true` is treated as absent rather than rejected.
func TestTrialsTreatAnUnrecognisedOptInAsAbsent(t *testing.T) {
	a := serve(t)
	if got := a.get("/v1/billing/trials?include_stripe_managed=yes"); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	got, called := a.lastCall()
	if !called {
		t.Fatal("the product was never called")
	}
	if strings.Contains(got.url, "include_stripe_managed") {
		t.Errorf("product asked %q; only `true` opts in", got.url)
	}
}

func TestRejectsUnknownParametersAndBadLimits(t *testing.T) {
	a := serve(t)
	// `include_stripe_managed` is a TRIALS parameter; on subscriptions it is
	// an unknown one, and a rejected typo is cheaper than a filter that
	// silently did nothing.
	if got := a.get("/v1/billing/subscriptions?include_stripe_managed=true"); got.status != http.StatusBadRequest {
		t.Errorf("subs with a trials-only param: status = %d, want 400", got.status)
	}
	if got := a.get("/v1/billing/trials?limit=abc"); got.status != http.StatusBadRequest {
		t.Errorf("limit=abc: status = %d, want 400", got.status)
	}
	// Refused, not clamped: a revenue page that silently shows fewer rows is
	// one somebody concludes things from.
	if got := a.get("/v1/billing/trials?limit=99999"); got.status != http.StatusBadRequest {
		t.Errorf("oversized limit: status = %d, want 400", got.status)
	}
	if got := a.get("/v1/billing/subscriptions?source=nosuch"); got.status != http.StatusBadRequest {
		t.Errorf("unknown source: status = %d, want 400", got.status)
	}
}

// 501, never an empty 200 — §8.2 forbids an empty list meaning "no billing",
// and an unconfigured estate must not render as a solvent one with no customers.
func TestNotImplementedWhenNoProductDeclaresBilling(t *testing.T) {
	a := serveNoProducts(t)
	for _, path := range []string{"/v1/billing/subscriptions", "/v1/billing/trials"} {
		if got := a.get(path); got.status != http.StatusNotImplemented {
			t.Errorf("%s: status = %d, want 501: %s", path, got.status, got.raw)
		}
	}
}
