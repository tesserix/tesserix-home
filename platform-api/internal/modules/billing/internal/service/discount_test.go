package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// received is one request the stub product got.
type received struct {
	method  string
	path    string
	body    string
	headers http.Header
}

// discountSvc wires a service over one product answering every write with
// `body`. calls is nil-length until the product is reached, which is what the
// refusal tests assert on.
func discountSvc(t *testing.T, status int, body string) (*Service, *[]received) {
	t.Helper()
	calls := new([]received)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		read, _ := io.ReadAll(r.Body)
		*calls = append(*calls, received{
			method: r.Method, path: r.URL.Path, body: string(read), headers: r.Header.Clone(),
		})
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())
	return New(fed, []string{"mark8ly"}, testLogger()), calls
}

// mark8ly's own wire shape, and NOT wrapped in a `data` envelope — see the
// decode in discount() for why that is stated rather than assumed.
const productDiscountBody = `{"tenant_id":"11111111-1111-1111-1111-111111111111","coupon_id":"LOYAL20",` +
	`"operation":"apply","reason":"goodwill after the outage","performed_at":"2026-09-06T10:00:00Z",` +
	`"status":"partial","requires_reconciliation":true,"stores":[` +
	`{"store_id":"s1","subscription_id":"sub1","stripe_customer_id":"cus_1",` +
	`"stripe_subscription_id":"sub_stripe_1","outcome":"applied"},` +
	`{"store_id":"s2","outcome":"failed","failure_code":"stripe_changed_audit_write_failed",` +
	`"failure_reason":"stripe accepted the discount change but the audit row was not written"}]}`

const bareTenantUUID = "11111111-1111-1111-1111-111111111111"
const namespacedTenant = "mark8ly:" + bareTenantUUID

func request() domain.DiscountRequest {
	return domain.DiscountRequest{CouponID: "LOYAL20", Reason: "goodwill after the outage"}
}

// A mutation aimed at a product nobody named is the one failure this split
// exists to prevent, so the refusal must happen BEFORE anything leaves the
// process.
func TestDiscountRefusesAnIDThatNamesNoProductWithoutCallingAnything(t *testing.T) {
	for _, id := range []string{"", bareTenantUUID, ":" + bareTenantUUID, "mark8ly:"} {
		s, calls := discountSvc(t, http.StatusOK, productDiscountBody)
		if _, err := s.ApplyDiscount(context.Background(), op(), id, request(), "k-1"); !errors.Is(err, ErrUnknownSource) {
			t.Errorf("ApplyDiscount(%q) err = %v, want ErrUnknownSource", id, err)
		}
		if len(*calls) != 0 {
			t.Errorf("ApplyDiscount(%q) reached the product: %+v", id, *calls)
		}
	}
}

func TestDiscountRefusesASlugThisDeploymentCannotCall(t *testing.T) {
	s, calls := discountSvc(t, http.StatusOK, productDiscountBody)
	_, err := s.ApplyDiscount(context.Background(), op(), "kora:"+bareTenantUUID, request(), "k-1")
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
	if len(*calls) != 0 {
		t.Errorf("an unconfigured slug still reached a product: %+v", *calls)
	}
}

// The product takes a BARE uuid — its handler parses the path parameter with
// uuid.Parse and answers `invalid_tenant_id` for anything else, so the
// namespace must be stripped here and not passed on.
func TestApplyPostsTheBareProductIDAndForwardsTheKey(t *testing.T) {
	s, calls := discountSvc(t, http.StatusOK, productDiscountBody)
	if _, err := s.ApplyDiscount(context.Background(), op(), namespacedTenant, request(), "k-42"); err != nil {
		t.Fatalf("ApplyDiscount: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(*calls))
	}
	got := (*calls)[0]
	if got.method != http.MethodPost {
		t.Errorf("method = %q, want POST", got.method)
	}
	if want := "/admin/billing/tenants/" + bareTenantUUID + "/discount"; got.path != want {
		t.Errorf("path = %q, want %q", got.path, want)
	}
	if got.headers.Get("Idempotency-Key") != "k-42" {
		t.Errorf("Idempotency-Key = %q, want the caller's own k-42",
			got.headers.Get("Idempotency-Key"))
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(got.body), &sent); err != nil {
		t.Fatalf("body %q: %v", got.body, err)
	}
	if sent["coupon_id"] != "LOYAL20" || sent["reason"] != "goodwill after the outage" {
		t.Errorf("body = %v, want the coupon and the reason", sent)
	}
}

func TestRemovePostsToTheRemoveSegment(t *testing.T) {
	s, calls := discountSvc(t, http.StatusOK, productDiscountBody)
	if _, err := s.RemoveDiscount(context.Background(), op(), namespacedTenant, request(), "k-1"); err != nil {
		t.Fatalf("RemoveDiscount: %v", err)
	}
	got := (*calls)[0]
	if want := "/admin/billing/tenants/" + bareTenantUUID + "/discount/remove"; got.path != want {
		t.Errorf("path = %q, want %q", got.path, want)
	}
	if got.method != http.MethodPost {
		t.Errorf("method = %q, want POST — the revoke carries a signed body", got.method)
	}
}

// The report is the point of the endpoint, so every line of it has to survive
// the hop: the summary, the divergence flag, and each store's own outcome.
func TestPartialAndRequiresReconciliationSurviveTheReProjection(t *testing.T) {
	s, _ := discountSvc(t, http.StatusOK, productDiscountBody)
	res, err := s.ApplyDiscount(context.Background(), op(), namespacedTenant, request(), "k-1")
	if err != nil {
		t.Fatalf("ApplyDiscount: %v", err)
	}
	if res.Status != domain.DiscountStatusPartial {
		t.Errorf("status = %q, want partial", res.Status)
	}
	if !res.RequiresReconciliation {
		t.Error("requires_reconciliation was lost — stripe changed and no audit row explains it")
	}
	if len(res.Stores) != 2 {
		t.Fatalf("stores = %d, want 2", len(res.Stores))
	}
	if res.Stores[0].Outcome != domain.StoreOutcomeApplied ||
		res.Stores[0].StripeSubscriptionID != "sub_stripe_1" ||
		res.Stores[0].SubscriptionID != "sub1" ||
		res.Stores[0].StripeCustomerID != "cus_1" {
		t.Errorf("applied store = %+v, want its ids carried", res.Stores[0])
	}
	if res.Stores[1].Outcome != domain.StoreOutcomeFailed ||
		res.Stores[1].FailureCode != "stripe_changed_audit_write_failed" ||
		res.Stores[1].FailureReason == "" {
		t.Errorf("failed store = %+v, want its code and fixed reason carried", res.Stores[1])
	}
	if res.CouponID != "LOYAL20" || res.PerformedAt != "2026-09-06T10:00:00Z" {
		t.Errorf("result = %+v, want the coupon and the instant carried", res)
	}
}

// Source is stamped from the slug CALLED and Operation from the call made, so
// neither can be named by a product into something it did not do.
func TestTheResultIsStampedFromTheCallAndNotTheBody(t *testing.T) {
	misreporting := `{"tenant_id":"` + bareTenantUUID + `","coupon_id":"LOYAL20","operation":"remove",` +
		`"performed_at":"2026-09-06T10:00:00Z","status":"ok","stores":[]}`
	s, _ := discountSvc(t, http.StatusOK, misreporting)
	res, err := s.ApplyDiscount(context.Background(), op(), namespacedTenant, request(), "k-1")
	if err != nil {
		t.Fatalf("ApplyDiscount: %v", err)
	}
	if res.Operation != "apply" {
		t.Errorf("operation = %q; an apply must not be reported as a remove because the body said so",
			res.Operation)
	}
	if res.Source != "mark8ly" {
		t.Errorf("source = %q, want it stamped from the slug called", res.Source)
	}
}

// The caller's own reason is not handed back to them.
func TestTheResultDoesNotCarryTheReasonTheCallerSent(t *testing.T) {
	s, _ := discountSvc(t, http.StatusOK, productDiscountBody)
	res, _ := s.ApplyDiscount(context.Background(), op(), namespacedTenant, request(), "k-1")
	out, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(out, &fields); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := fields["reason"]; ok {
		t.Errorf("reason survived the re-projection: %s", out)
	}
}

// An outcome this build has never heard of must be NAMED, never an empty
// string that renders as though the store had no outcome.
func TestAnUnrecognisedOutcomeIsNamedRatherThanBlank(t *testing.T) {
	newer := `{"tenant_id":"` + bareTenantUUID + `","coupon_id":"c","operation":"apply",` +
		`"performed_at":"2026-09-06T10:00:00Z","status":"ok","stores":[{"store_id":"s1","outcome":"invoiced_later"}]}`
	s, _ := discountSvc(t, http.StatusOK, newer)
	res, err := s.ApplyDiscount(context.Background(), op(), namespacedTenant, request(), "k-1")
	if err != nil {
		t.Fatalf("ApplyDiscount: %v", err)
	}
	if res.Stores[0].Outcome != domain.StoreOutcomeUnknown {
		t.Errorf("outcome = %q, want the named unknown", res.Stores[0].Outcome)
	}
}

// Returned UNWRAPPED, so the handler can still read the product's §4.4 code
// out of it. Wrapping with %v — the easy mistake — would destroy it.
func TestAProductRefusalKeepsItsErrorCode(t *testing.T) {
	s, _ := discountSvc(t, http.StatusConflict, `{"error":"override_already_recorded","message":"..."}`)
	_, err := s.ApplyDiscount(context.Background(), op(), namespacedTenant, request(), "k-1")
	if err == nil {
		t.Fatal("a 409 from the product was not an error")
	}
	code, ok := federation.ErrorCode(err)
	if !ok || code != "override_already_recorded" {
		t.Errorf("ErrorCode = %q,%v; want the product's own code to survive", code, ok)
	}
}

// Federation refuses a write with no key, and that refusal must reach the
// caller rather than being turned into a call with an invented one.
func TestDiscountWithNoKeyNeverReachesTheProduct(t *testing.T) {
	s, calls := discountSvc(t, http.StatusOK, productDiscountBody)
	_, err := s.ApplyDiscount(context.Background(), op(), namespacedTenant, request(), "")
	if !errors.Is(err, federation.ErrIdempotencyKeyRequired) {
		t.Errorf("err = %v, want ErrIdempotencyKeyRequired", err)
	}
	if len(*calls) != 0 {
		t.Errorf("a keyless write reached the product: %+v", *calls)
	}
}
