package federation

import (
	"log/slog"
	"strings"
	"testing"
)

func TestRegistryGetReturnsAConfiguredProduct(t *testing.T) {
	r := NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{{Name: "mark8ly", BaseURL: "http://m", Secret: "s"}}},
	})

	got, ok := r.Get("mark8ly")
	if !ok {
		t.Fatal("expected mark8ly to be configured")
	}
	if len(got.Services) != 1 || got.Services[0].BaseURL != "http://m" {
		t.Fatalf("Services = %+v, want one service with BaseURL %q", got.Services, "http://m")
	}
}

func TestRegistryGetFailsClosedOnUnknownProduct(t *testing.T) {
	r := NewRegistry(nil)

	if _, ok := r.Get("mark8ly"); ok {
		t.Fatal("an unconfigured product must not be reported as configured")
	}
}

func TestSlugsAreSortedSoFanOutIsDeterministic(t *testing.T) {
	r := NewRegistry([]Product{
		{Slug: "kora", Services: []Service{{Name: "kora", BaseURL: "http://k", Secret: "s"}}},
		{Slug: "mark8ly", Services: []Service{{Name: "mark8ly", BaseURL: "http://m", Secret: "s"}}},
	})

	got := r.Slugs()
	if len(got) != 2 || got[0] != "kora" || got[1] != "mark8ly" {
		t.Fatalf("Slugs() = %v, want [kora mark8ly]", got)
	}
}

func TestLoadRegistryReadsOnlyDeclaredProducts(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":         "mark8ly",
		"FEDERATION_MARK8LY_BASE_URL": "http://m",
		"FEDERATION_MARK8LY_SECRET":   "s",
		"FEDERATION_KORA_BASE_URL":    "http://k",
		"FEDERATION_KORA_SECRET":      "s",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}

	if _, ok := r.Get("kora"); ok {
		t.Fatal("kora is configured but not declared in FEDERATION_PRODUCTS; it must not be callable")
	}
	if _, ok := r.Get("mark8ly"); !ok {
		t.Fatal("mark8ly is declared and configured; it must be callable")
	}
}

func TestLoadRegistryRefusesADeclaredProductWithNoBaseURL(t *testing.T) {
	env := map[string]string{"FEDERATION_PRODUCTS": "mark8ly"}

	if _, err := LoadRegistry(func(k string) string { return env[k] }); err == nil {
		t.Fatal("a declared product with no base URL must be a startup error, not a silent skip")
	}
}

// A declared product with no SECRET is exactly as fatal as one with no
// BASE_URL, and the failure it prevents is worse. Client.Get sends
// `X-Internal-Auth: <secret>` unconditionally, so an empty one is an
// UNAUTHENTICATED federated call that still carries operator identity headers
// — a typo in FEDERATION_MARK8LY_SECRET silently downgrading the one client
// whose entire purpose is carrying signed operator identity.
func TestLoadRegistryRefusesADeclaredProductWithNoSecret(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":         "mark8ly",
		"FEDERATION_MARK8LY_BASE_URL": "http://m",
	}

	_, err := LoadRegistry(func(k string) string { return env[k] })
	if err == nil {
		t.Fatal("a declared product with no secret must be a startup error — an empty X-Internal-Auth is an unauthenticated federation call, not a degraded one")
	}
	if !strings.Contains(err.Error(), "FEDERATION_MARK8LY_SECRET") {
		t.Errorf("err = %v, want it to name the env var that is empty", err)
	}
}

// A whitespace-only secret is an empty one. It is what a here-doc or a
// mis-quoted Kubernetes secret produces, and it must not read as configured.
func TestLoadRegistryRefusesABlankSecret(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":         "mark8ly",
		"FEDERATION_MARK8LY_BASE_URL": "http://m",
		"FEDERATION_MARK8LY_SECRET":   "   ",
	}

	if _, err := LoadRegistry(func(k string) string { return env[k] }); err == nil {
		t.Fatal("a whitespace-only secret must be refused: it reaches the wire as an empty X-Internal-Auth")
	}
}

// A repeated slug used to collapse silently into the registry's map — last
// declaration wins, and which declaration that is depends on the order someone
// typed an env var in. This file is the estate's blast-radius control; a
// product whose coordinates are decided by a typo is not a control.
func TestLoadRegistryRefusesADuplicateSlug(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":         "mark8ly,mark8ly",
		"FEDERATION_MARK8LY_BASE_URL": "http://m",
		"FEDERATION_MARK8LY_SECRET":   "s",
	}

	_, err := LoadRegistry(func(k string) string { return env[k] })
	if err == nil {
		t.Fatal("a duplicate slug must be a startup error, not a silent last-wins overwrite")
	}
	if !strings.Contains(err.Error(), "mark8ly") {
		t.Errorf("err = %v, want it to name the duplicated slug", err)
	}
}

func TestSlugsServingReturnsOnlyProductsDeclaringThatEntity(t *testing.T) {
	r := NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{{Name: "mark8ly", BaseURL: "http://m", Secret: "s", Entities: []string{"tenants"}}}},
		{Slug: "kora", Services: []Service{{Name: "kora", BaseURL: "http://k", Secret: "s", Entities: []string{"users", "foods"}}}},
		{Slug: "quiet", Services: []Service{{Name: "quiet", BaseURL: "http://q", Secret: "s"}}},
	})
	if got := r.SlugsServing("tenants"); len(got) != 1 || got[0] != "mark8ly" {
		t.Errorf("SlugsServing(tenants) = %v, want [mark8ly]", got)
	}
	if got := r.SlugsServing("users"); len(got) != 1 || got[0] != "kora" {
		t.Errorf("SlugsServing(users) = %v, want [kora]", got)
	}
	// A product declaring nothing serves nothing. Absence means no, the same
	// rule FEDERATION_PRODUCTS itself uses.
	if got := r.SlugsServing("anything"); len(got) != 0 {
		t.Errorf("SlugsServing(anything) = %v, want empty", got)
	}
}

func TestSlugsServingIsSorted(t *testing.T) {
	r := NewRegistry([]Product{
		{Slug: "zeta", Services: []Service{{Name: "zeta", BaseURL: "http://z", Secret: "s", Entities: []string{"tenants"}}}},
		{Slug: "alpha", Services: []Service{{Name: "alpha", BaseURL: "http://a", Secret: "s", Entities: []string{"tenants"}}}},
	})
	got := r.SlugsServing("tenants")
	if len(got) != 2 || got[0] != "alpha" || got[1] != "zeta" {
		t.Errorf("SlugsServing = %v, want sorted [alpha zeta]", got)
	}
}

func TestLoadRegistryReadsDeclaredEntities(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":         "mark8ly",
		"FEDERATION_MARK8LY_BASE_URL": "http://m",
		"FEDERATION_MARK8LY_SECRET":   "s",
		"FEDERATION_MARK8LY_ENTITIES": " tenants , users ",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}
	p, _ := r.Get("mark8ly")
	if got := p.Entities(); len(got) != 2 || got[0] != "tenants" || got[1] != "users" {
		t.Errorf("Entities() = %v, want [tenants users] trimmed", got)
	}
}

// Entities is OPTIONAL, unlike BASE_URL and SECRET: a product that federates
// audit logs but serves no entity type is a normal configuration, not an error.
func TestLoadRegistryAcceptsAProductWithNoEntities(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":         "mark8ly",
		"FEDERATION_MARK8LY_BASE_URL": "http://m",
		"FEDERATION_MARK8LY_SECRET":   "s",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}
	if p, _ := r.Get("mark8ly"); len(p.Entities()) != 0 {
		t.Errorf("Entities() = %v, want none", p.Entities())
	}
}

// The legacy shape — no FEDERATION_<SLUG>_SERVICES at all — must produce
// exactly what it always has: one service, synthesized from the product-level
// keys. Kora has no reason to ever declare SERVICES, and must keep working
// with zero configuration change.
func TestLoadRegistryLegacySingleServiceShapeIsUnchanged(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":       "kora",
		"FEDERATION_KORA_BASE_URL":  "http://k/",
		"FEDERATION_KORA_SECRET":    "s",
		"FEDERATION_KORA_ENTITIES":  "users,foods",
		"FEDERATION_KORA_ENDPOINTS": "billing",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}
	p, ok := r.Get("kora")
	if !ok {
		t.Fatal("expected kora to be configured")
	}
	if len(p.Services) != 1 {
		t.Fatalf("Services = %+v, want exactly one, synthesized from the product-level keys", p.Services)
	}
	svc := p.Services[0]
	if svc.BaseURL != "http://k" {
		t.Errorf("BaseURL = %q, want the trailing slash trimmed", svc.BaseURL)
	}
	if svc.Secret != "s" {
		t.Errorf("Secret = %q, want %q", svc.Secret, "s")
	}
	if got := p.Entities(); len(got) != 2 || got[0] != "foods" || got[1] != "users" {
		t.Errorf("Entities() = %v, want [foods users] (sorted)", got)
	}
	if got := p.Endpoints(); len(got) != 1 || got[0] != "billing" {
		t.Errorf("Endpoints() = %v, want [billing]", got)
	}
}

// The multi-service shape: FEDERATION_<SLUG>_SERVICES names each service, and
// each reads its own per-service env block.
func TestLoadRegistryParsesMultipleServices(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":                         "mark8ly",
		"FEDERATION_MARK8LY_SERVICES":                 "marketplace-api,platform-api",
		"FEDERATION_MARK8LY_DEFAULT_SERVICE":          "marketplace-api",
		"FEDERATION_MARK8LY_MARKETPLACE_API_BASE_URL": "http://marketplace",
		"FEDERATION_MARK8LY_MARKETPLACE_API_SECRET":   "s1",
		"FEDERATION_MARK8LY_MARKETPLACE_API_ENTITIES": "tenants",
		"FEDERATION_MARK8LY_PLATFORM_API_BASE_URL":    "http://platform/api/v1/platform",
		"FEDERATION_MARK8LY_PLATFORM_API_SECRET":      "s2",
		"FEDERATION_MARK8LY_PLATFORM_API_ENDPOINTS":   "billing",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}
	p, ok := r.Get("mark8ly")
	if !ok {
		t.Fatal("expected mark8ly to be configured")
	}
	if len(p.Services) != 2 {
		t.Fatalf("Services = %+v, want exactly two", p.Services)
	}
	byName := make(map[string]Service, len(p.Services))
	for _, svc := range p.Services {
		byName[svc.Name] = svc
	}
	mp, ok := byName["marketplace-api"]
	if !ok || mp.BaseURL != "http://marketplace" || mp.Secret != "s1" {
		t.Errorf("marketplace-api = %+v, want BaseURL http://marketplace, Secret s1", mp)
	}
	if len(mp.Entities) != 1 || mp.Entities[0] != "tenants" {
		t.Errorf("marketplace-api.Entities = %v, want [tenants]", mp.Entities)
	}
	pa, ok := byName["platform-api"]
	if !ok || pa.BaseURL != "http://platform/api/v1/platform" || pa.Secret != "s2" {
		t.Errorf("platform-api = %+v, want BaseURL http://platform/api/v1/platform, Secret s2", pa)
	}
	if len(pa.Endpoints) != 1 || pa.Endpoints[0] != "billing" {
		t.Errorf("platform-api.Endpoints = %v, want [billing]", pa.Endpoints)
	}
}

// A service named in SERVICES with no BASE_URL is exactly as fatal as the
// legacy shape's missing BASE_URL, and the error must name BOTH the product
// and the service — a multi-service product's config error is meaningless
// without knowing which service it is.
func TestLoadRegistryRefusesAServiceWithNoBaseURL(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":                    "mark8ly",
		"FEDERATION_MARK8LY_SERVICES":            "platform-api",
		"FEDERATION_MARK8LY_PLATFORM_API_SECRET": "s",
	}
	_, err := LoadRegistry(func(k string) string { return env[k] })
	if err == nil {
		t.Fatal("a declared service with no base URL must be a startup error, not a silent skip")
	}
	if !strings.Contains(err.Error(), "mark8ly") || !strings.Contains(err.Error(), "platform-api") {
		t.Errorf("err = %v, want it to name both the product and the service", err)
	}
}

// Exactly the same failure mode, one field over. Client.do sends the secret
// as an HMAC key unconditionally — an empty one signs nothing, and the
// far end's 401 carries no hint that the cause was local configuration.
func TestLoadRegistryRefusesAServiceWithNoSecret(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":                      "mark8ly",
		"FEDERATION_MARK8LY_SERVICES":              "platform-api",
		"FEDERATION_MARK8LY_PLATFORM_API_BASE_URL": "http://platform",
	}
	_, err := LoadRegistry(func(k string) string { return env[k] })
	if err == nil {
		t.Fatal("a declared service with no secret must be a startup error")
	}
	if !strings.Contains(err.Error(), "mark8ly") || !strings.Contains(err.Error(), "platform-api") {
		t.Errorf("err = %v, want it to name both the product and the service", err)
	}
}

// Two services of one product legitimately implementing the same endpoint is
// the entire reason this shape exists: mark8ly's email-template registry is
// split across marketplace-api (order/billing keys) and platform-api (auth
// keys), and the console must see both halves. This must parse successfully,
// and ServicesImplementing must return both, in a stable order — NOT be
// rejected at boot. An earlier version of this file rejected it; that was
// wrong, because it made the split unimplementable.
func TestTwoServicesMayShareAnEndpointAndBothAreReturned(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":                          "mark8ly",
		"FEDERATION_MARK8LY_SERVICES":                  "platform-api,marketplace-api",
		"FEDERATION_MARK8LY_DEFAULT_SERVICE":           "platform-api",
		"FEDERATION_MARK8LY_PLATFORM_API_BASE_URL":     "http://platform",
		"FEDERATION_MARK8LY_PLATFORM_API_SECRET":       "s1",
		"FEDERATION_MARK8LY_PLATFORM_API_ENDPOINTS":    "email-templates",
		"FEDERATION_MARK8LY_MARKETPLACE_API_BASE_URL":  "http://marketplace",
		"FEDERATION_MARK8LY_MARKETPLACE_API_SECRET":    "s2",
		"FEDERATION_MARK8LY_MARKETPLACE_API_ENDPOINTS": "email-templates",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("two services sharing an endpoint must parse — the split email-template registry depends on it: %v", err)
	}

	got := r.ServicesImplementing("email-templates")
	if len(got) != 2 {
		t.Fatalf("ServicesImplementing(email-templates) = %+v, want both services", got)
	}
	// Sorted by service name so a fan-out's order is stable across runs.
	if got[0].Name != "marketplace-api" || got[1].Name != "platform-api" {
		t.Errorf("ServicesImplementing(email-templates) = [%s %s], want [marketplace-api platform-api]",
			got[0].Name, got[1].Name)
	}

	// SlugsImplementing must still answer at the product level: the union
	// means mark8ly appears once, not twice.
	if slugs := r.SlugsImplementing("email-templates"); len(slugs) != 1 || slugs[0] != "mark8ly" {
		t.Errorf("SlugsImplementing(email-templates) = %v, want [mark8ly]", slugs)
	}
}

// Same story, one level up: two services legitimately declaring the same
// entity type must both be returned by ServicesServing.
func TestTwoServicesMayShareAnEntityAndBothAreReturned(t *testing.T) {
	r := NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "platform-api", BaseURL: "http://p", Secret: "s1", Entities: []string{"tenants"}},
			{Name: "marketplace-api", BaseURL: "http://m", Secret: "s2", Entities: []string{"tenants"}},
		}},
	})

	got := r.ServicesServing("tenants")
	if len(got) != 2 || got[0].Name != "marketplace-api" || got[1].Name != "platform-api" {
		t.Fatalf("ServicesServing(tenants) = %+v, want both services sorted by name", got)
	}
}

// A repeated service NAME in SERVICES is a different failure than two
// services sharing an endpoint: it is a config typo (the same slug typed
// twice), not a legitimate split, and must still be rejected the same way a
// repeated product slug is.
func TestLoadRegistryRefusesADuplicateServiceName(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":                      "mark8ly",
		"FEDERATION_MARK8LY_SERVICES":              "platform-api,platform-api",
		"FEDERATION_MARK8LY_PLATFORM_API_BASE_URL": "http://platform",
		"FEDERATION_MARK8LY_PLATFORM_API_SECRET":   "s",
	}
	_, err := LoadRegistry(func(k string) string { return env[k] })
	if err == nil {
		t.Fatal("a service name repeated in SERVICES must be a startup error, not a silent collapse")
	}
	if !strings.Contains(err.Error(), "platform-api") {
		t.Errorf("err = %v, want it to name the duplicated service", err)
	}
}

// The env for a product is deployed before this code (k8s-first): there is
// necessarily a window where the chart carries both SERVICES and the old
// product-level BASE_URL/SECRET. That must not fail — it must warn, ignore
// the product-level values, and use the per-service ones.
func TestLoadRegistryWarnsAndIgnoresProductLevelKeysWhenServicesIsPresent(t *testing.T) {
	var logged strings.Builder
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
	defer slog.SetDefault(restore)

	env := map[string]string{
		"FEDERATION_PRODUCTS":                      "mark8ly",
		"FEDERATION_MARK8LY_BASE_URL":              "http://old",
		"FEDERATION_MARK8LY_SECRET":                "old-secret",
		"FEDERATION_MARK8LY_SERVICES":              "platform-api",
		"FEDERATION_MARK8LY_PLATFORM_API_BASE_URL": "http://new",
		"FEDERATION_MARK8LY_PLATFORM_API_SECRET":   "new-secret",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("both-present must not fail — the k8s rollout order requires this window to be deployable: %v", err)
	}

	p, _ := r.Get("mark8ly")
	if len(p.Services) != 1 || p.Services[0].BaseURL != "http://new" || p.Services[0].Secret != "new-secret" {
		t.Fatalf("Services = %+v, want the per-service keys to win, not the ignored product-level ones", p.Services)
	}

	out := logged.String()
	if !strings.Contains(out, "FEDERATION_MARK8LY_BASE_URL") || !strings.Contains(out, "FEDERATION_MARK8LY_SECRET") {
		t.Errorf("expected a warning naming the ignored product-level vars, got: %s", out)
	}
}
