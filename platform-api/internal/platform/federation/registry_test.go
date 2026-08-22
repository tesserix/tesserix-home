package federation

import "testing"

func TestRegistryGetReturnsAConfiguredProduct(t *testing.T) {
	r := NewRegistry([]Product{{Slug: "mark8ly", BaseURL: "http://m", Secret: "s"}})

	got, ok := r.Get("mark8ly")
	if !ok {
		t.Fatal("expected mark8ly to be configured")
	}
	if got.BaseURL != "http://m" {
		t.Fatalf("BaseURL = %q, want %q", got.BaseURL, "http://m")
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
		{Slug: "kora", BaseURL: "http://k", Secret: "s"},
		{Slug: "mark8ly", BaseURL: "http://m", Secret: "s"},
	})

	got := r.Slugs()
	if len(got) != 2 || got[0] != "kora" || got[1] != "mark8ly" {
		t.Fatalf("Slugs() = %v, want [kora mark8ly]", got)
	}
}

func TestLoadRegistryReadsOnlyDeclaredProducts(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":          "mark8ly",
		"FEDERATION_MARK8LY_BASE_URL":  "http://m",
		"FEDERATION_MARK8LY_SECRET":    "s",
		"FEDERATION_KORA_BASE_URL":     "http://k",
		"FEDERATION_KORA_SECRET":       "s",
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
