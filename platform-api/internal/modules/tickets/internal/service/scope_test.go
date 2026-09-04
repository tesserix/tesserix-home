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

const (
	tenantA = "3f2a1c94-0000-4000-8000-0000000000aa"
	tenantB = "3f2a1c94-0000-4000-8000-0000000000bb"
)

func TestAnUnscopedCallerSeesEverything(t *testing.T) {
	// An operator. Empty ProductID is not "no products" — it is "the estate",
	// which is what a human on the support surface has always had.
	s := Scope{}
	if !s.Unscoped() {
		t.Fatal("the zero Scope must be unscoped")
	}
	for _, product := range []string{"mark8ly", "kora", ""} {
		if !s.Admits(product, "any-tenant") {
			t.Errorf("an unscoped caller should admit %q", product)
		}
	}
}

func TestAScopedCallerAdmitsOnlyItsOwnProduct(t *testing.T) {
	s := Scope{ProductID: "mark8ly", TenantID: tenantA}
	if !s.Admits("mark8ly", tenantA) {
		t.Error("a scoped caller must admit its own product and tenant")
	}
	if s.Admits("kora", tenantA) {
		t.Error("a scoped caller admitted another product — this is the leak #152 exists to close")
	}
}

// The SECOND containment, and the one apps/web states outright: "without that
// check, any tenant holding the shared bearer could read any other tenant's
// tickets" (app/api/internal/platform-tickets/[id]/route.ts). Product scoping
// alone would let mark8ly read every mark8ly merchant's queue.
func TestAScopedCallerAdmitsOnlyTheTenantItNamed(t *testing.T) {
	s := Scope{ProductID: "mark8ly", TenantID: tenantA}
	if s.Admits("mark8ly", tenantB) {
		t.Error("a scoped caller reached another tenant inside its own product")
	}
	if s.Admits("mark8ly", "") {
		t.Error("a scoped caller admitted a ticket with no tenant")
	}
}

func TestAScopedCallerDoesNotAdmitAProductlessTicket(t *testing.T) {
	// A row with no product_id must not fall into somebody's scope by virtue
	// of matching nothing. The comparison is "equal to mine", never "not
	// obviously someone else's".
	if (Scope{ProductID: "mark8ly", TenantID: tenantA}).Admits("", tenantA) {
		t.Error("a scoped caller admitted a ticket with no product")
	}
}

func TestApplyForcesTheScopedProductOntoAnUnfilteredRequest(t *testing.T) {
	// The caller sent no product filter. It does not thereby get the estate.
	got, err := Scope{ProductID: "mark8ly", TenantID: tenantA}.Apply(repository.Filter{Status: "open"})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got.Product != "mark8ly" {
		t.Errorf("Product = %q, want mark8ly", got.Product)
	}
	if got.Tenant != tenantA {
		t.Errorf("Tenant = %q, want %q — a product caller must not read across its tenants", got.Tenant, tenantA)
	}
	if got.Status != "open" {
		t.Errorf("Apply dropped an unrelated filter: Status = %q", got.Status)
	}
}

func TestApplyRefusesAFilterNamingAnotherProduct(t *testing.T) {
	// Refused rather than silently rewritten. Answering a question about
	// Kora's queue with mark8ly's rows would be a response that misrepresents
	// the request, which is worse than a refusal for the caller and no safer.
	_, err := Scope{ProductID: "mark8ly", TenantID: tenantA}.Apply(repository.Filter{Product: "kora"})
	if err == nil {
		t.Fatal("a filter naming another product was accepted")
	}
	if !errors.Is(err, ErrRefused) {
		t.Errorf("want ErrRefused, got %v", err)
	}
}

func TestApplyAcceptsAFilterNamingTheCallersOwnProduct(t *testing.T) {
	// mark8ly's client sends ?product=mark8ly today. That must keep working.
	got, err := Scope{ProductID: "mark8ly", TenantID: tenantA}.Apply(repository.Filter{Product: "mark8ly"})
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
	if _, err := (Scope{ProductID: "mark8ly", TenantID: tenantA}).Apply(in); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if in.Product != "" {
		t.Errorf("Apply mutated the caller's filter: Product = %q", in.Product)
	}
}

// ForTenant is where the tenant a product ASSERTS becomes part of its scope.
//
// The product asserts it, and that is the same trust model apps/web has today:
// mark8ly authenticates its own merchant and forwards which tenant that
// merchant belongs to. What must NOT be possible is declining to say.

func TestForTenantRefusesAScopedCallerThatNamesNoTenant(t *testing.T) {
	// The gap this closes: without it, a machine omitting the tenant read
	// every tenant's tickets inside its product.
	_, err := Scope{ProductID: "mark8ly"}.ForTenant("")
	if err == nil {
		t.Fatal("a product caller was allowed to omit its tenant")
	}
	if !errors.Is(err, ErrRefused) {
		t.Errorf("want ErrRefused, got %v", err)
	}
}

func TestForTenantCarriesTheTenantOntoTheScope(t *testing.T) {
	got, err := Scope{ProductID: "mark8ly"}.ForTenant(tenantA)
	if err != nil {
		t.Fatalf("ForTenant: %v", err)
	}
	if got.TenantID != tenantA || got.ProductID != "mark8ly" {
		t.Errorf("scope = %+v, want mark8ly/%s", got, tenantA)
	}
}

func TestForTenantLeavesAnOperatorUnscopedEvenWithNoTenant(t *testing.T) {
	// An operator names no tenant and must keep the estate-wide view.
	got, err := Scope{}.ForTenant("")
	if err != nil {
		t.Fatalf("ForTenant: %v", err)
	}
	if !got.Unscoped() {
		t.Errorf("an operator was scoped to %+v", got)
	}
}

func TestForTenantDoesNotMutateTheReceiver(t *testing.T) {
	original := Scope{ProductID: "mark8ly"}
	if _, err := original.ForTenant(tenantA); err != nil {
		t.Fatalf("ForTenant: %v", err)
	}
	if original.TenantID != "" {
		t.Errorf("ForTenant mutated its receiver: TenantID = %q", original.TenantID)
	}
}
