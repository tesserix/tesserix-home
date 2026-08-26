package handler_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const idemHeader = "Idempotency-Key"

func withKey(k string) map[string]string { return map[string]string{idemHeader: k} }

func TestSuspendAcceptsAWellFormedRequest(t *testing.T) {
	a := serve(t)
	got := a.do(http.MethodPost, "/v1/tenants/mark8ly:t1/suspend",
		`{"reason_code":"fraud","reason":"chargebacks"}`, withKey("idem-1"))
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
}

// Refused rather than generated. A key this service invented would be fresh on
// every retry, which is the same as having none.
func TestSuspendWithoutAnIdempotencyKeyIsFourHundred(t *testing.T) {
	a := serve(t)
	got := a.do(http.MethodPost, "/v1/tenants/mark8ly:t1/suspend",
		`{"reason_code":"fraud"}`, nil)
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// A suspension with no stated reason produces an audit row nobody can act on
// later. This surface's own concern, so it is refused here rather than at the
// product.
func TestSuspendWithoutAReasonCodeIsFourHundred(t *testing.T) {
	a := serve(t)
	for _, body := range []string{`{}`, `{"reason_code":""}`, `{"reason_code":"   "}`} {
		got := a.do(http.MethodPost, "/v1/tenants/mark8ly:t1/suspend", body, withKey("idem-1"))
		if got.status != http.StatusBadRequest {
			t.Errorf("body %s = %d, want 400", body, got.status)
		}
	}
}

func TestSuspendWithAMalformedBodyIsFourHundred(t *testing.T) {
	a := serve(t)
	got := a.do(http.MethodPost, "/v1/tenants/mark8ly:t1/suspend", `{not json`, withKey("idem-1"))
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// A bare id names no product, so there is nothing to call. Refused rather than
// guessed at — guessing means choosing a product to mutate.
func TestSuspendWithAnIdNamingNoProductIsFourHundred(t *testing.T) {
	a := serve(t)
	got := a.do(http.MethodPost, "/v1/tenants/t1/suspend", `{"reason_code":"fraud"}`, withKey("idem-1"))
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

func TestSuspendWithAnUnconfiguredProductIsFourHundred(t *testing.T) {
	a := serve(t)
	got := a.do(http.MethodPost, "/v1/tenants/kora:t1/suspend", `{"reason_code":"fraud"}`, withKey("idem-1"))
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

func TestUnsuspendAcceptsAWellFormedRequest(t *testing.T) {
	a := serve(t)
	got := a.do(http.MethodPost, "/v1/tenants/mark8ly:t1/unsuspend",
		`{"reason_code":"resolved"}`, withKey("idem-1"))
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
}

func TestSuspendWithoutPlatformIsFourOhThree(t *testing.T) {
	a := serveSlugs(t, []string{productSlug}, "support")
	got := a.do(http.MethodPost, "/v1/tenants/mark8ly:t1/suspend",
		`{"reason_code":"fraud"}`, withKey("idem-1"))
	if got.status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", got.status, got.raw)
	}
}

// A write route must not answer a GET. Checked with a raw request rather than
// the `do` helper: ServeMux refuses a wrong method with a plain-text 405, and
// `do` fails the test trying to parse that as JSON — which would report a
// correct refusal as a broken response.
func TestSuspendIsNotReachableByGet(t *testing.T) {
	a := serve(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/tenants/mark8ly:t1/suspend", nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET on a write route = %d, want 405: %s", rec.Code, rec.Body.String())
	}
}
