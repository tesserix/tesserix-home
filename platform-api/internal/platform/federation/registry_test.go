package federation

import (
	"strings"
	"testing"
)

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
