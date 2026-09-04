package service

import (
	"errors"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/repository"
)

// Scope is the whole of #152's containment, so these are the tests that decide
// whether one product can read another's tickets. They are deliberately pure —
// no pool, no testdb — because the module's database tests SKIP when
// TESSERIX_TEST_DB_* is unset, and a containment rule whose tests only run on
// a developer's machine is not a containment rule.

func TestAnUnscopedCallerSeesEverything(t *testing.T) {
	// An operator. Empty ProductID is not "no products" — it is "the estate",
	// which is what a human on the support surface has always had.
	s := Scope{}
	if !s.Unscoped() {
		t.Fatal("the zero Scope must be unscoped")
	}
	for _, product := range []string{"mark8ly", "kora", ""} {
		if !s.Admits(product) {
			t.Errorf("an unscoped caller should admit %q", product)
		}
	}
}

func TestAScopedCallerAdmitsOnlyItsOwnProduct(t *testing.T) {
	s := Scope{ProductID: "mark8ly"}
	if !s.Admits("mark8ly") {
		t.Error("a scoped caller must admit its own product")
	}
	if s.Admits("kora") {
		t.Error("a scoped caller admitted another product — this is the leak #152 exists to close")
	}
}

func TestAScopedCallerDoesNotAdmitAProductlessTicket(t *testing.T) {
	// A row with no product_id must not fall into somebody's scope by virtue
	// of matching nothing. The comparison is "equal to mine", never "not
	// obviously someone else's".
	if (Scope{ProductID: "mark8ly"}).Admits("") {
		t.Error("a scoped caller admitted a ticket with no product")
	}
}

func TestApplyForcesTheScopedProductOntoAnUnfilteredRequest(t *testing.T) {
	// The caller sent no product filter. It does not thereby get the estate.
	got, err := Scope{ProductID: "mark8ly"}.Apply(repository.Filter{Status: "open"})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got.Product != "mark8ly" {
		t.Errorf("Product = %q, want mark8ly", got.Product)
	}
	if got.Status != "open" {
		t.Errorf("Apply dropped an unrelated filter: Status = %q", got.Status)
	}
}

func TestApplyRefusesAFilterNamingAnotherProduct(t *testing.T) {
	// Refused rather than silently rewritten. Answering a question about
	// Kora's queue with mark8ly's rows would be a response that misrepresents
	// the request, which is worse than a refusal for the caller and no safer.
	_, err := Scope{ProductID: "mark8ly"}.Apply(repository.Filter{Product: "kora"})
	if err == nil {
		t.Fatal("a filter naming another product was accepted")
	}
	if !errors.Is(err, ErrRefused) {
		t.Errorf("want ErrRefused, got %v", err)
	}
}

func TestApplyAcceptsAFilterNamingTheCallersOwnProduct(t *testing.T) {
	// mark8ly's client sends ?product=mark8ly today. That must keep working.
	got, err := Scope{ProductID: "mark8ly"}.Apply(repository.Filter{Product: "mark8ly"})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got.Product != "mark8ly" {
		t.Errorf("Product = %q, want mark8ly", got.Product)
	}
}

func TestApplyLeavesAnUnscopedFilterAlone(t *testing.T) {
	// An operator filtering by product is using a filter, not being contained
	// by one.
	got, err := Scope{}.Apply(repository.Filter{Product: "kora"})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got.Product != "kora" {
		t.Errorf("Product = %q, want kora", got.Product)
	}
}

func TestApplyDoesNotMutateItsInput(t *testing.T) {
	in := repository.Filter{Status: "open"}
	if _, err := (Scope{ProductID: "mark8ly"}).Apply(in); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if in.Product != "" {
		t.Errorf("Apply mutated the caller's filter: Product = %q", in.Product)
	}
}
