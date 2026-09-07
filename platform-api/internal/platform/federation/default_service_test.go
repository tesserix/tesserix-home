package federation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestPlainGetOnASingleServiceProductIsUnchangedByDefaultService is the
// compatibility case: a single-service product has nothing to disambiguate,
// so a selector-less Get must behave exactly as it did before DefaultService
// existed, whether or not DefaultService happens to be set.
func TestPlainGetOnASingleServiceProductIsUnchangedByDefaultService(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "kora", Services: []Service{{Name: "kora", BaseURL: srv.URL, Secret: "s"}}},
	}), srv.Client())

	if _, err := c.Get(context.Background(), "kora", "/admin/audit-logs", operator()); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if gotPath != "/admin/audit-logs" {
		t.Fatalf("gotPath = %q, want /admin/audit-logs", gotPath)
	}
}

// TestPlainGetOnAMultiServiceProductRoutesToTheDefaultService is the hole
// this change closes: before DefaultService existed, a selector-less Get to
// a two-service product failed EVERY time with ErrAmbiguousService — proven
// empirically against mark8ly-shaped config in the investigation that led to
// this change. With a DefaultService declared, the same call must succeed
// and land on the declared service, not merely "not error" — asserted here
// by which httptest server actually received the request.
func TestPlainGetOnAMultiServiceProductRoutesToTheDefaultService(t *testing.T) {
	marketplaceHit := false
	marketplace := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		marketplaceHit = true
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer marketplace.Close()

	platformHit := false
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		platformHit = true
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer platform.Close()

	c := NewClient(NewRegistry([]Product{
		{
			Slug: "mark8ly",
			Services: []Service{
				{Name: "marketplace-api", BaseURL: marketplace.URL, Secret: "s1"},
				{Name: "platform-api", BaseURL: platform.URL, Secret: "s2"},
			},
			DefaultService: "marketplace-api",
		},
	}), marketplace.Client())

	if _, err := c.Get(context.Background(), "mark8ly", "/admin/kpis", operator()); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !marketplaceHit {
		t.Error("the default service (marketplace-api) was not called")
	}
	if platformHit {
		t.Error("the non-default service (platform-api) must not have been called")
	}
}

// TestAuditLogsRegressionOnMark8lyShapedTwoServiceProduct is the exact
// regression this change guards against. It reproduces, byte for byte, the
// failure mode reported in the investigation: `Client.Get` to
// /admin/audit-logs on a two-service mark8ly-shaped product used to answer
//
//	federation: more than one service matches; call every match instead of
//	guessing: mark8ly has 2 services for no endpoint or entity (path
//	/admin/audit-logs)
//
// unconditionally — the failure did not depend on what either service
// served, only on there being two of them. If this test ever fails again,
// mark8ly's audit-logs and KPIs surfaces are broken in production the moment
// its config gains a second service, exactly as they were before this fix.
func TestAuditLogsRegressionOnMark8lyShapedTwoServiceProduct(t *testing.T) {
	marketplace := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"log-1"}]}`))
	}))
	defer marketplace.Close()
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("platform-api must not receive the selector-less audit-logs call")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer platform.Close()

	reg, err := LoadRegistry(func(k string) string {
		env := map[string]string{
			"FEDERATION_PRODUCTS":                         "mark8ly",
			"FEDERATION_MARK8LY_SERVICES":                 "marketplace-api,platform-api",
			"FEDERATION_MARK8LY_DEFAULT_SERVICE":          "marketplace-api",
			"FEDERATION_MARK8LY_MARKETPLACE_API_BASE_URL": marketplace.URL,
			"FEDERATION_MARK8LY_MARKETPLACE_API_SECRET":   "s1",
			"FEDERATION_MARK8LY_PLATFORM_API_BASE_URL":    platform.URL,
			"FEDERATION_MARK8LY_PLATFORM_API_SECRET":      "s2",
		}
		return env[k]
	})
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}

	c := NewClient(reg, marketplace.Client())

	body, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs", operator())
	if err != nil {
		t.Fatalf("Get(/admin/audit-logs) = %v, want success — this is the exact production breakage #720 left open", err)
	}
	if !strings.Contains(string(body), "log-1") {
		t.Fatalf("body = %s, want it to contain the marketplace-api response", body)
	}
}

// TestLoadRegistryRefusesAMultiServiceProductWithNoDefaultService is the
// boot-time half of the guarantee: a multi-service product that never
// declares DEFAULT_SERVICE must fail at startup, naming the product and
// listing its services — not silently boot into a state where every
// selector-less call 500s later.
func TestLoadRegistryRefusesAMultiServiceProductWithNoDefaultService(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":                         "mark8ly",
		"FEDERATION_MARK8LY_SERVICES":                 "marketplace-api,platform-api",
		"FEDERATION_MARK8LY_MARKETPLACE_API_BASE_URL": "http://marketplace",
		"FEDERATION_MARK8LY_MARKETPLACE_API_SECRET":   "s1",
		"FEDERATION_MARK8LY_PLATFORM_API_BASE_URL":    "http://platform",
		"FEDERATION_MARK8LY_PLATFORM_API_SECRET":      "s2",
	}
	_, err := LoadRegistry(func(k string) string { return env[k] })
	if err == nil {
		t.Fatal("a multi-service product with no DEFAULT_SERVICE must be a startup error")
	}
	if !strings.Contains(err.Error(), "mark8ly") {
		t.Errorf("err = %v, want it to name the product", err)
	}
	if !strings.Contains(err.Error(), "marketplace-api") || !strings.Contains(err.Error(), "platform-api") {
		t.Errorf("err = %v, want it to list the product's services", err)
	}
}

// TestLoadRegistryRefusesADefaultServiceNamingAnUnknownService is the second
// boot-time guard: DEFAULT_SERVICE must name one of the product's own
// declared services, or a typo silently degrades every selector-less call.
func TestLoadRegistryRefusesADefaultServiceNamingAnUnknownService(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":                         "mark8ly",
		"FEDERATION_MARK8LY_SERVICES":                 "marketplace-api,platform-api",
		"FEDERATION_MARK8LY_DEFAULT_SERVICE":          "platform-apiv2",
		"FEDERATION_MARK8LY_MARKETPLACE_API_BASE_URL": "http://marketplace",
		"FEDERATION_MARK8LY_MARKETPLACE_API_SECRET":   "s1",
		"FEDERATION_MARK8LY_PLATFORM_API_BASE_URL":    "http://platform",
		"FEDERATION_MARK8LY_PLATFORM_API_SECRET":      "s2",
	}
	_, err := LoadRegistry(func(k string) string { return env[k] })
	if err == nil {
		t.Fatal("a DEFAULT_SERVICE naming a service the product does not have must be a startup error")
	}
	if !strings.Contains(err.Error(), "platform-apiv2") {
		t.Errorf("err = %v, want it to name the unknown DEFAULT_SERVICE value", err)
	}
}

// TestLoadRegistrySingleServiceProductDoesNotRequireDefaultService pins that
// the new requirement is scoped to multi-service products: kora, and any
// product with exactly one Service (whether legacy shape or a one-entry
// SERVICES list), must keep booting with zero configuration change.
func TestLoadRegistrySingleServiceProductDoesNotRequireDefaultService(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":      "kora",
		"FEDERATION_KORA_BASE_URL": "http://k",
		"FEDERATION_KORA_SECRET":   "s",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("a single-service product must not require DEFAULT_SERVICE: %v", err)
	}
	p, ok := r.Get("kora")
	if !ok {
		t.Fatal("expected kora to be configured")
	}
	if len(p.Services) != 1 {
		t.Fatalf("Services = %+v, want exactly one", p.Services)
	}
}

// TestExplicitSelectorStillResolvesAndStillFailsClosedWithDefaultServiceSet
// proves DefaultService only ever changes the ZERO-value Selector path: an
// explicit ForEndpoint/ForEntity call must still resolve to the declaring
// service, and must still fail closed with ErrAmbiguousService on genuine
// ambiguity (the split email-template registry), even though this product
// now also has a DefaultService configured.
func TestExplicitSelectorStillResolvesAndStillFailsClosedWithDefaultServiceSet(t *testing.T) {
	marketplace := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer marketplace.Close()
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer platform.Close()

	c := NewClient(NewRegistry([]Product{
		{
			Slug: "mark8ly",
			Services: []Service{
				{Name: "marketplace-api", BaseURL: marketplace.URL, Secret: "s1", Endpoints: []string{"outbox", "email-templates"}},
				{Name: "platform-api", BaseURL: platform.URL, Secret: "s2", Endpoints: []string{"billing", "email-templates"}},
			},
			DefaultService: "marketplace-api",
		},
	}), marketplace.Client())

	// An explicit selector resolves to the declaring service, not the
	// default — "billing" is platform-api's alone.
	if _, err := c.GetForEndpoint(context.Background(), "mark8ly", "billing", "/admin/billing", operator()); err != nil {
		t.Fatalf("GetForEndpoint(billing): %v", err)
	}

	// Genuine ambiguity (both services declare email-templates) must still
	// fail closed, DefaultService notwithstanding — DefaultService only
	// applies to the selector-less path.
	_, err := c.GetForEndpoint(context.Background(), "mark8ly", "email-templates", "/admin/email-templates", operator())
	if !errors.Is(err, ErrAmbiguousService) {
		t.Fatalf("GetForEndpoint(email-templates) err = %v, want ErrAmbiguousService — DefaultService must not silently resolve a real ambiguity", err)
	}
}
