package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "billing"}
}

func testLogger() *slog.Logger {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil))
}

// svc wires a service over the given slug→body map, recording asked URLs.
func svc(t *testing.T, bodies map[string]string) (*Service, map[string]*string) {
	t.Helper()
	products := make([]federation.Product, 0, len(bodies))
	slugs := make([]string, 0, len(bodies))
	asked := make(map[string]*string, len(bodies))
	for slug, body := range bodies {
		captured := new(string)
		asked[slug] = captured
		b := body
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*captured = r.URL.String()
			_, _ = w.Write([]byte(b))
		}))
		t.Cleanup(srv.Close)
		products = append(products, federation.Product{Slug: slug, BaseURL: srv.URL, Secret: "s"})
		slugs = append(slugs, slug)
	}
	fed := federation.NewClient(federation.NewRegistry(products), nil)
	return New(fed, slugs, testLogger()), asked
}

const mark8lySubs = `{"data":[
 {"tenant_id":"t1","tenant_name":"Acme","plan":"pro","status":"active","amount":{"amount":4900,"currency":"AUD"},"current_period_end":"2026-09-30T00:00:00Z"},
 {"tenant_id":"t2","plan":"lite","status":"past_due","current_period_end":"2026-09-02T00:00:00Z"}
],"pagination":{"page":1,"limit":100,"total":37}}`

const mark8lyTrials = `{"data":[
 {"tenant_id":"t3","trial_ends_at":"2026-09-10T00:00:00Z","days_remaining":9,"plan":"pro","payment_method_on_file":false,"status":"trialing"},
 {"tenant_id":"t4","trial_ends_at":"2026-08-28T00:00:00Z","days_remaining":2,"plan":"pro","payment_method_on_file":true,"status":"trialing"}
],"pagination":{"page":1,"limit":100,"total":5}}`

func TestSubscriptionsReadsRowsAndTheProductsOwnTotal(t *testing.T) {
	s, _ := svc(t, map[string]string{"mark8ly": mark8lySubs})
	page, err := s.Subscriptions(context.Background(), op(), Query{Limit: 100})
	if err != nil {
		t.Fatalf("Subscriptions: %v", err)
	}
	if len(page.Data) != 2 {
		t.Fatalf("rows = %d, want 2", len(page.Data))
	}
	// The product's own count, which exceeds the page returned.
	if page.Total != 37 {
		t.Errorf("total = %d, want the product's own 37", page.Total)
	}
	if page.Data[0].Source != "mark8ly" {
		t.Errorf("source = %q, want it stamped from the slug called", page.Data[0].Source)
	}
}

// §4.2: minor units with an explicit currency. A bare 4900 is 49 dollars or 49
// rupees depending on a fact the payload no longer carries.
func TestSubscriptionsCarryMoneyWithItsCurrency(t *testing.T) {
	s, _ := svc(t, map[string]string{"mark8ly": mark8lySubs})
	page, _ := s.Subscriptions(context.Background(), op(), Query{Limit: 100})
	paid := page.Data[1] // sorted by period end; t1 renews later than t2
	_ = paid
	var withAmount int
	for _, row := range page.Data {
		if row.Amount != nil {
			withAmount++
			if row.Amount.Amount != 4900 || row.Amount.Currency != "AUD" {
				t.Errorf("amount = %+v, want minor units with a currency", row.Amount)
			}
		}
	}
	if withAmount != 1 {
		t.Errorf("rows with an amount = %d, want 1", withAmount)
	}
}

// Absent is not zero. Rendering a missing price as 0 would say "this tenant
// pays nothing", which is a different and wrong claim.
func TestSubscriptionsLeaveAnUnknownAmountAbsent(t *testing.T) {
	s, _ := svc(t, map[string]string{"mark8ly": mark8lySubs})
	page, _ := s.Subscriptions(context.Background(), op(), Query{Limit: 100})
	for _, row := range page.Data {
		if row.TenantID == "t2" && row.Amount != nil {
			t.Errorf("amount = %+v, want nil for a row with no resolvable price", row.Amount)
		}
	}
}

// Soonest renewal first — the order a revenue surface is read in.
func TestSubscriptionsSortSoonestRenewalFirst(t *testing.T) {
	s, _ := svc(t, map[string]string{"mark8ly": mark8lySubs})
	page, _ := s.Subscriptions(context.Background(), op(), Query{Limit: 100})
	if page.Data[0].TenantID != "t2" {
		t.Errorf("first = %q, want the soonest renewal (t2)", page.Data[0].TenantID)
	}
}

// An unknown date is not an imminent one; putting it first would make it look
// urgent.
func TestSubscriptionsSortRowsWithNoPeriodEndLast(t *testing.T) {
	body := `{"data":[{"tenant_id":"none","plan":"p","status":"active"},{"tenant_id":"soon","plan":"p","status":"active","current_period_end":"2026-09-01T00:00:00Z"}],"pagination":{"page":1,"limit":100,"total":2}}`
	s, _ := svc(t, map[string]string{"mark8ly": body})
	page, _ := s.Subscriptions(context.Background(), op(), Query{Limit: 100})
	if page.Data[0].TenantID != "soon" || page.Data[1].TenantID != "none" {
		t.Errorf("order = %q,%q; a row with no date must sort last",
			page.Data[0].TenantID, page.Data[1].TenantID)
	}
}

// A work queue, not a report: the trial ending soonest is acted on today.
func TestTrialsSortFewestDaysRemainingFirst(t *testing.T) {
	s, _ := svc(t, map[string]string{"mark8ly": mark8lyTrials})
	page, err := s.Trials(context.Background(), op(), Query{Limit: 100})
	if err != nil {
		t.Fatalf("Trials: %v", err)
	}
	if page.Data[0].DaysRemaining != 2 {
		t.Errorf("first = %d days, want the soonest (2)", page.Data[0].DaysRemaining)
	}
	// The field that makes this a queue rather than a report.
	if page.Data[0].PaymentMethodOnFile != true {
		t.Errorf("payment_method_on_file not carried: %+v", page.Data[0])
	}
}

func TestTrialsForwardTheStripeManagedOptIn(t *testing.T) {
	s, asked := svc(t, map[string]string{"mark8ly": mark8lyTrials})
	if _, err := s.Trials(context.Background(), op(), Query{Limit: 100}); err != nil {
		t.Fatalf("Trials: %v", err)
	}
	if bytes.Contains([]byte(*asked["mark8ly"]), []byte("include_stripe_managed")) {
		t.Error("sent include_stripe_managed without being asked to")
	}
	if _, err := s.Trials(context.Background(), op(), Query{Limit: 100, IncludeStripeManaged: true}); err != nil {
		t.Fatalf("Trials: %v", err)
	}
	if !bytes.Contains([]byte(*asked["mark8ly"]), []byte("include_stripe_managed=true")) {
		t.Errorf("asked %q, want the opt-in forwarded", *asked["mark8ly"])
	}
}

// Two products' rows merge, and the totals sum. Needs MORE THAN ONE product to
// exercise the concurrent accumulator FanOut runs per slug.
func TestSubscriptionsMergeAcrossProductsWithoutRacing(t *testing.T) {
	second := `{"data":[{"tenant_id":"o1","plan":"basic","status":"active","current_period_end":"2026-08-31T00:00:00Z"}],"pagination":{"page":1,"limit":100,"total":4}}`
	s, _ := svc(t, map[string]string{"mark8ly": mark8lySubs, "other": second})
	page, err := s.Subscriptions(context.Background(), op(), Query{Limit: 100})
	if err != nil {
		t.Fatalf("Subscriptions: %v", err)
	}
	if len(page.Data) != 3 {
		t.Errorf("rows = %d, want 3 merged", len(page.Data))
	}
	if page.Total != 41 {
		t.Errorf("total = %d, want 37+4=41", page.Total)
	}
}

// One product failing must not take out the surface, and the total must
// understate rather than silently omit — which is why failures render beside it.
func TestOneFailedProductDoesNotLoseTheOthers(t *testing.T) {
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(broken.Close)

	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(mark8lySubs))
	}))
	t.Cleanup(good.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: good.URL, Secret: "s"},
		{Slug: "other", BaseURL: broken.URL, Secret: "s"},
	}), nil)
	page, err := New(fed, []string{"mark8ly", "other"}, testLogger()).
		Subscriptions(context.Background(), op(), Query{Limit: 100})
	if err != nil {
		t.Fatalf("Subscriptions: %v", err)
	}
	if len(page.Data) != 2 {
		t.Errorf("rows = %d, want the healthy product's 2", len(page.Data))
	}
	if len(page.Failures) != 1 || page.Failures[0].Source != "other" {
		t.Fatalf("failures = %+v, want one naming `other`", page.Failures)
	}
	if page.Total != 37 {
		t.Errorf("total = %d, want only the answering product's 37", page.Total)
	}
}

// §8.2 forbids an empty list meaning "no billing" — indistinguishable from "no
// subscriptions". An unconfigured estate must not render as a solvent one with
// no customers.
func TestRefusesWhenNoProductImplementsBilling(t *testing.T) {
	s := New(federation.NewClient(federation.NewRegistry(nil), nil), nil, testLogger())
	if _, err := s.Subscriptions(context.Background(), op(), Query{Limit: 100}); !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
	if _, err := s.Trials(context.Background(), op(), Query{Limit: 100}); !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("trials err = %v, want ErrNotInstrumented", err)
	}
}

func TestRefusesAnUnknownSource(t *testing.T) {
	s, _ := svc(t, map[string]string{"mark8ly": mark8lySubs})
	_, err := s.Subscriptions(context.Background(), op(), Query{Source: "nope", Limit: 100})
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
}
