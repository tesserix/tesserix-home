package handler_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/handler"
)

const (
	bareTenantUUID   = "11111111-1111-1111-1111-111111111111"
	namespacedTenant = productSlug + ":" + bareTenantUUID
	validDiscount    = `{"coupon_id":"LOYAL20","reason":"goodwill after the outage"}`
	applyPath        = "/v1/billing/tenants/" + namespacedTenant + "/discount"
	removePath       = applyPath + "/remove"
)

// The product takes a BARE uuid: its handler parses the path segment with
// uuid.Parse and answers `invalid_tenant_id` for anything else.
func TestTheDiscountWriteSendsTheBareProductIDAndTheCallersKey(t *testing.T) {
	a := serve(t)
	if got := a.post(applyPath, validDiscount); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	sent, called := a.lastCall()
	if !called {
		t.Fatal("the product was never called")
	}
	if want := "/admin/billing/tenants/" + bareTenantUUID + "/discount"; sent.url != want {
		t.Errorf("product asked %q, want %q — the namespace is this surface's, not the product's",
			sent.url, want)
	}
	if sent.method != http.MethodPost {
		t.Errorf("method = %q, want POST", sent.method)
	}
	if sent.headers.Get("Idempotency-Key") != "k-1" {
		t.Errorf("Idempotency-Key = %q, want the caller's own", sent.headers.Get("Idempotency-Key"))
	}
	if sent.headers.Get("X-Platform-Capability") != "publish-catalog" {
		t.Errorf("signed capability = %q, want publish-catalog — the verb being exercised, which "+
			"the product records on the audit row", sent.headers.Get("X-Platform-Capability"))
	}
}

func TestTheRemoveWriteReachesTheRemoveSegment(t *testing.T) {
	a := serve(t)
	if got := a.post(removePath, validDiscount); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	sent, _ := a.lastCall()
	if want := "/admin/billing/tenants/" + bareTenantUUID + "/discount/remove"; sent.url != want {
		t.Errorf("product asked %q, want %q", sent.url, want)
	}
}

// A mutation aimed at a product nobody named is refused, and refused BEFORE
// anything leaves this process.
func TestAnIDThatNamesNoProductIsRefusedWithoutCallingAnything(t *testing.T) {
	for _, id := range []string{bareTenantUUID, ":" + bareTenantUUID, productSlug + ":"} {
		a := serve(t)
		got := a.post("/v1/billing/tenants/"+id+"/discount", validDiscount)
		if got.status != http.StatusBadRequest {
			t.Errorf("tenant %q: status = %d, want 400: %s", id, got.status, got.raw)
		}
		if c, called := a.lastCall(); called {
			t.Errorf("tenant %q still reached the product: %s %s", id, c.method, c.url)
		}
	}
}

// Required and REFUSED, never generated: a key this service invented would be
// fresh on every retry, which is the same as having none.
func TestAWriteWithNoIdempotencyKeyIsRefusedBeforeAnythingLeaves(t *testing.T) {
	for _, p := range []string{applyPath, removePath} {
		a := serve(t)
		got := a.do(http.MethodPost, p, validDiscount, nil)
		if got.status != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", p, got.status, got.raw)
		}
		if c, called := a.lastCall(); called {
			t.Errorf("%s: a keyless write reached the product: %s %s", p, c.method, c.url)
		}
	}
}

// Both are refused here rather than left to the product, because the product's
// refusal arrives as a bare code and each of these has an obvious sentence.
func TestAMissingCouponOrReasonIsRefusedBeforeAnythingLeaves(t *testing.T) {
	for _, body := range []string{`{}`, `{"coupon_id":"LOYAL20"}`, `{"reason":"goodwill"}`, `{"coupon_id":" ","reason":"x"}`} {
		a := serve(t)
		if got := a.post(applyPath, body); got.status != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400: %s", body, got.status, got.raw)
		}
		if c, called := a.lastCall(); called {
			t.Errorf("body %s reached the product: %s %s", body, c.method, c.url)
		}
	}
}

// The report is the point of the endpoint. A partial fan-out is answered 200
// with the truth in the body rather than a status code the console would have
// to learn to branch on: `status` and `requires_reconciliation` are fields it
// already has to read.
func TestAPartialResultIsA200CarryingTheDivergenceFlag(t *testing.T) {
	got := serve(t).post(applyPath, validDiscount)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data := got.data(t)
	if data["status"] != "partial" {
		t.Errorf("status = %v, want partial", data["status"])
	}
	if data["requires_reconciliation"] != true {
		t.Errorf("requires_reconciliation = %v, want true — stripe changed and no audit row explains it",
			data["requires_reconciliation"])
	}
	if _, echoed := data["reason"]; echoed {
		t.Errorf("the caller's own reason was echoed back: %s", got.raw)
	}
	stores, ok := data["stores"].([]any)
	if !ok || len(stores) != 2 {
		t.Fatalf("stores = %v, want the product's two lines", data["stores"])
	}
	failed, _ := stores[1].(map[string]any)
	if failed["outcome"] != "failed" || failed["failure_code"] != "stripe_changed_audit_write_failed" {
		t.Errorf("failed store = %v, want its outcome and code carried", failed)
	}
	if failed["failure_reason"] == "" || failed["failure_reason"] == nil {
		t.Errorf("failure_reason was dropped: %v — it is mark8ly's own fixed vocabulary, not driver text", failed)
	}
}

// The product's §4.4 code is passed through. Collapsing every refusal to "the
// product said no" leaves an operator staring at a form with no idea which
// part of it the product objected to.
func TestAProductRefusalIsA400NamingItsCode(t *testing.T) {
	a := serveProduct(t, refusing(http.StatusConflict, `{"error":"override_already_recorded","message":"..."}`),
		[]string{productSlug}, "billing", "publish-catalog")
	got := a.post(applyPath, validDiscount)
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
	if !contains(got.raw, "override_already_recorded") {
		t.Errorf("the response does not name the product's code: %s", got.raw)
	}
}

// No code and no answer at all — the product was never reached. 503, and
// deliberately not the error's own text, which carries hostnames.
func TestAnUnreachableProductIs503AndNamesNoHost(t *testing.T) {
	a := serveProduct(t, refusing(http.StatusBadGateway, "<html>gateway</html>"),
		[]string{productSlug}, "billing", "publish-catalog")
	got := a.post(applyPath, validDiscount)
	if got.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", got.status, got.raw)
	}
	if contains(got.raw, "127.0.0.1") || contains(got.raw, "http://") {
		t.Errorf("the response leaks the product's address: %s", got.raw)
	}
}

// THE decision this module makes on these two routes, asserted on its own: an
// operator who may READ the estate's revenue has not thereby been granted
// permission to change a live billing arrangement.
func TestTheDiscountWritesAreRefusedToAnOperatorHoldingOnlyBilling(t *testing.T) {
	a := serveAs(t, []string{productSlug}, "billing")

	// The reads are open to them...
	if got := a.get("/v1/billing/subscriptions"); got.status != http.StatusOK {
		t.Fatalf("subscriptions with `billing` = %d, want 200: %s", got.status, got.raw)
	}
	// That read legitimately reached the product; drained so the assertion
	// below is about the writes and nothing else.
	a.lastCall()

	// ...and the writes are not.
	for _, p := range []string{applyPath, removePath} {
		if got := a.post(p, validDiscount); got.status != http.StatusForbidden {
			t.Errorf("%s with `billing` alone = %d, want 403 — reading revenue is not changing it: %s",
				p, got.status, got.raw)
		}
	}
	if c, called := a.lastCall(); called {
		t.Errorf("a refused write still reached the product: %s %s", c.method, c.url)
	}
}

// The mirror image, so the test above cannot pass for the wrong reason:
// `publish-catalog` without the surface is not a way in either.
func TestTheDiscountWritesAreRefusedToAPrincipalHoldingOnlyTheVerb(t *testing.T) {
	a := serveAs(t, []string{productSlug}, "publish-catalog")
	for _, p := range []string{applyPath, removePath} {
		if got := a.post(p, validDiscount); got.status != http.StatusForbidden {
			t.Errorf("%s with `publish-catalog` alone = %d, want 403 — the verb means 'may do the "+
				"consequential thing WHERE they work', not everywhere: %s", p, got.status, got.raw)
		}
	}
	if c, called := a.lastCall(); called {
		t.Errorf("a refused write still reached the product: %s %s", c.method, c.url)
	}
}

// The API is the authorisation boundary. #244 put surface refusal in the
// console's middleware; if this service authorised only "is this a valid
// token", anything holding a session could call the module directly and every
// console restriction would be decoration.
func TestEveryRouteRefusesAValidSessionHoldingNeitherCapability(t *testing.T) {
	a := serveAs(t, []string{productSlug}, "read")
	for _, r := range handler.RouteTable {
		got := a.exercise(r, caseFor(t, r))
		if got.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403 — a valid session is not authorisation: %s",
				r.Method, r.Pattern, got.status, got.raw)
		}
	}
	if c, called := a.lastCall(); called {
		t.Errorf("a refused request still reached the product: %s %s", c.method, c.url)
	}
}

// refusing answers every request with one refusal, so a test can pin what this
// surface makes of it.
func refusing(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
