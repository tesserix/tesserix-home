package httpx_test

import (
	"net/url"
	"reflect"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

func TestRejectUnknownParametersAllowsAKnownQuery(t *testing.T) {
	query := url.Values{"stage": {"new"}, "owner": {"jill"}}

	err := httpx.RejectUnknownParameters(query, []string{"stage", "owner", "limit"})

	if err != nil {
		t.Errorf("want nil for an all-known query, got %v", err)
	}
}

func TestRejectUnknownParametersNamesTheParameterAndItsValue(t *testing.T) {
	query := url.Values{"stge": {"new"}}

	err := httpx.RejectUnknownParameters(query, []string{"stage", "owner"})

	var envelope httpx.Error
	if err == nil {
		t.Fatal("want an error for an unknown parameter, got nil")
	}
	envelope = httpx.From(err)
	if envelope.StatusCode != 400 {
		t.Errorf("want 400, got %d", envelope.StatusCode)
	}
	if envelope.Details["stge"] != "new" {
		t.Errorf("want the offending value recorded under its parameter name, got %v", envelope.Details)
	}
}

func TestRejectUnknownParametersReturnsTheAcceptedListSorted(t *testing.T) {
	query := url.Values{"stge": {"new"}}

	err := httpx.RejectUnknownParameters(query, []string{"owner", "stage", "limit"})

	envelope := httpx.From(err)
	accepted, ok := envelope.Details["accepted"].([]string)
	if !ok {
		t.Fatalf("want accepted to be a []string, got %T", envelope.Details["accepted"])
	}
	want := []string{"limit", "owner", "stage"}
	if !reflect.DeepEqual(accepted, want) {
		t.Errorf("accepted = %v, want sorted %v", accepted, want)
	}
}

func TestRejectUnknownParametersReportsMultipleUnknownsDeterministically(t *testing.T) {
	query := url.Values{"zeta": {"z"}, "alpha": {"a"}, "mid": {"m"}}
	allowed := []string{"stage"}

	for i := 0; i < 5; i++ {
		err := httpx.RejectUnknownParameters(query, allowed)
		envelope := httpx.From(err)

		if envelope.Details["zeta"] != "z" || envelope.Details["alpha"] != "a" || envelope.Details["mid"] != "m" {
			t.Fatalf("run %d: unknown parameters not all reported with their values: %v", i, envelope.Details)
		}
		accepted, ok := envelope.Details["accepted"].([]string)
		if !ok || !reflect.DeepEqual(accepted, []string{"stage"}) {
			t.Fatalf("run %d: accepted = %v, want [stage]", i, envelope.Details["accepted"])
		}
	}
}

func TestRejectUnknownParametersWithEmptyAllowedRejectsAnyParameter(t *testing.T) {
	query := url.Values{"anything": {"x"}}

	err := httpx.RejectUnknownParameters(query, nil)

	if err == nil {
		t.Fatal("want an error when nothing is allowed but a parameter is present, got nil")
	}
	envelope := httpx.From(err)
	if envelope.Details["anything"] != "x" {
		t.Errorf("want the offending value recorded, got %v", envelope.Details)
	}
	accepted, ok := envelope.Details["accepted"].([]string)
	if !ok || len(accepted) != 0 {
		t.Errorf("want an empty accepted list, got %v", envelope.Details["accepted"])
	}
}
