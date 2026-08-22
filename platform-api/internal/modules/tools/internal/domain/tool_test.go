package domain_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/domain"
)

func ptr[T any](v T) *T { return &v }

func TestNormaliseTrimsAndCollapsesAnEmptyNoteToAbsence(t *testing.T) {
	got := domain.Tool{
		Name:      "  Grafana  ",
		Subdomain: "  GRAFANA  ",
		Purpose:   "  Dashboards.  ",
		Note:      ptr("   "),
		GroupKey:  "  Observability ",
	}.Normalise()

	if got.Name != "Grafana" {
		t.Errorf("name = %q, want trimmed", got.Name)
	}
	// Lower-cased rather than refused: a capitalised subdomain is a typo with
	// one obvious reading, and the DNS label it becomes is unambiguous.
	if got.Subdomain != "grafana" {
		t.Errorf("subdomain = %q, want lower-cased and trimmed", got.Subdomain)
	}
	if got.Purpose != "Dashboards." {
		t.Errorf("purpose = %q, want trimmed", got.Purpose)
	}
	// A note of spaces is not a note. Collapsed BEFORE validation so it is
	// never refused for a length it does not have.
	if got.Note != nil {
		t.Errorf("note = %q, want nil for whitespace", *got.Note)
	}
	// GroupKey is also lower-cased and trimmed: every stored group key is lower-case
	// by construction since groupKeyPattern is ^[a-z][a-z0-9-]*$.
	if got.GroupKey != "observability" {
		t.Errorf("group_key = %q, want lower-cased and trimmed", got.GroupKey)
	}
}

func TestValidateRefusesASubdomainThatIsNotADnsLabel(t *testing.T) {
	for _, bad := range []string{
		"https://grafana.tesserix.app",
		"grafana.tesserix.app",
		"-leading",
		"trailing-",
		"under_score",
		"",
		strings.Repeat("a", 64),
	} {
		err := domain.Tool{Name: "x", Subdomain: bad, Purpose: "x", GroupKey: "reference"}.Validate()
		if err == nil {
			t.Errorf("subdomain %q was accepted; the API must refuse what the CHECK refuses", bad)
		}
	}
}

func TestValidateAcceptsTheSubdomainsAlreadyInUse(t *testing.T) {
	for _, good := range []string{"auth", "secret-service", "costestimator", "ui", "analytics"} {
		err := domain.Tool{Name: "x", Subdomain: good, Purpose: "x", GroupKey: "reference"}.Validate()
		if err != nil {
			t.Errorf("subdomain %q was refused but is in the seed: %v", good, err)
		}
	}
}

func TestValidateRequiresNameAndPurposeAndGroup(t *testing.T) {
	cases := map[string]domain.Tool{
		"no name":    {Subdomain: "x", Purpose: "x", GroupKey: "reference"},
		"no purpose": {Name: "x", Subdomain: "x", GroupKey: "reference"},
		"no group":   {Name: "x", Subdomain: "x", Purpose: "x"},
	}
	for name, tool := range cases {
		if err := tool.Validate(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestValidateRefusesAnOverlongField(t *testing.T) {
	longName := strings.Repeat("a", 81)
	if err := (domain.Tool{Name: longName, Subdomain: "x", Purpose: "x", GroupKey: "reference"}).Validate(); err == nil {
		t.Error("an 81-character name was accepted; the limit is 80")
	}
	longPurpose := strings.Repeat("a", 201)
	if err := (domain.Tool{Name: "x", Subdomain: "x", Purpose: longPurpose, GroupKey: "reference"}).Validate(); err == nil {
		t.Error("a 201-character purpose was accepted; the card cannot render it")
	}
	longNote := strings.Repeat("a", 201)
	if err := (domain.Tool{Name: "x", Subdomain: "x", Purpose: "x", GroupKey: "reference",
		Note: ptr(longNote)}).Validate(); err == nil {
		t.Error("a 201-character note was accepted")
	}
	longLabel := strings.Repeat("a", 61)
	if err := (domain.Group{Key: "reference", Label: longLabel}).Validate(); err == nil {
		t.Error("a 61-character label was accepted; the limit is 60")
	}
}

func TestValidateRefusesANegativeSortOrder(t *testing.T) {
	if err := (domain.Tool{Name: "x", Subdomain: "x", Purpose: "x", GroupKey: "reference",
		SortOrder: ptr(-1)}).Validate(); err == nil {
		t.Error("a negative sort_order was accepted")
	}
}

func TestAGroupValidatesItsKeyAsAnIdentifier(t *testing.T) {
	if err := (domain.Group{Key: "Not A Key", Label: "x"}).Validate(); err == nil {
		t.Error("a group key with spaces was accepted; it is referenced by tools")
	}
	if err := (domain.Group{Key: "observability", Label: ""}).Validate(); err == nil {
		t.Error("a group with no label was accepted; it renders as a blank heading")
	}
	if err := (domain.Group{Key: "observability", Label: "Observability"}).Validate(); err != nil {
		t.Errorf("a legitimate group was refused: %v", err)
	}
}
