package service

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestIndexInvertsEndpointDeclarationsIntoSourcesPerEndpoint(t *testing.T) {
	got := New(
		map[string][]string{"mark8ly": {"onboarding", "outbox"}, "kora": {"onboarding"}},
		nil,
	).Index()

	want := map[string][]string{
		"onboarding": {"kora", "mark8ly"},
		"outbox":     {"mark8ly"},
	}
	if !reflect.DeepEqual(got.Endpoints, want) {
		t.Errorf("Endpoints = %v, want %v", got.Endpoints, want)
	}
}

func TestIndexInvertsEntityDeclarationsToo(t *testing.T) {
	got := New(nil, map[string][]string{"mark8ly": {"tenants"}, "kora": {"users", "foods"}}).Index()

	want := map[string][]string{
		"foods":   {"kora"},
		"tenants": {"mark8ly"},
		"users":   {"kora"},
	}
	if !reflect.DeepEqual(got.Entities, want) {
		t.Errorf("Entities = %v, want %v", got.Entities, want)
	}
}

// A source picker renders this list in order. An unstable order makes two
// identical deployments look like different ones, the same reason
// Registry.Slugs sorts.
func TestSlugsAreSorted(t *testing.T) {
	got := New(map[string][]string{
		"zulu": {"onboarding"}, "alpha": {"onboarding"}, "mike": {"onboarding"},
	}, nil).Index()

	want := []string{"alpha", "mike", "zulu"}
	if !reflect.DeepEqual(got.Endpoints["onboarding"], want) {
		t.Errorf("Endpoints[onboarding] = %v, want %v", got.Endpoints["onboarding"], want)
	}
}

// A deployment federating nothing must render as two empty OBJECTS, not two
// nulls. `data.endpoints.onboarding` on a null is a TypeError, and a console
// that crashes on an empty estate is worse than one that shows no sources.
func TestAnEmptyEstateIsEmptyObjectsAndNotNull(t *testing.T) {
	encoded, err := json.Marshal(New(nil, nil).Index())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if want := `{"endpoints":{},"entities":{}}`; string(encoded) != want {
		t.Errorf("index = %s, want %s", encoded, want)
	}
}

// A product declaring the same endpoint twice — "onboarding,onboarding" in an
// env var — must not be listed twice. A picker showing mark8ly twice reads as
// two deployments of it.
func TestARepeatedDeclarationIsListedOnce(t *testing.T) {
	got := New(map[string][]string{"mark8ly": {"onboarding", "onboarding"}}, nil).Index()

	if want := []string{"mark8ly"}; !reflect.DeepEqual(got.Endpoints["onboarding"], want) {
		t.Errorf("Endpoints[onboarding] = %v, want %v", got.Endpoints["onboarding"], want)
	}
}
