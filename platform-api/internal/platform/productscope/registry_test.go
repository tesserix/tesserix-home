package productscope_test

import (
	"errors"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/productscope"
)

func env(pairs map[string]string) func(string) string {
	return func(k string) string { return pairs[k] }
}

func TestASubjectResolvesToTheProductItWasDeclaredUnder(t *testing.T) {
	reg, err := productscope.LoadRegistry(env(map[string]string{
		"PRODUCT_SCOPE_PRODUCTS":         "mark8ly",
		"PRODUCT_SCOPE_MARK8LY_SUBJECTS": "sub-123",
	}))
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	slug, ok := reg.ProductFor("sub-123")
	if !ok || slug != "mark8ly" {
		t.Fatalf("ProductFor(sub-123) = %q, %v; want mark8ly, true", slug, ok)
	}
}

// The property the whole design rests on: a caller not named in configuration
// gets no scope, and the caller cannot supply one. If this ever returned a
// default, every unmapped machine would silently acquire some product's queue.
func TestAnUndeclaredSubjectResolvesToNothing(t *testing.T) {
	reg, err := productscope.LoadRegistry(env(map[string]string{
		"PRODUCT_SCOPE_PRODUCTS":         "mark8ly",
		"PRODUCT_SCOPE_MARK8LY_SUBJECTS": "sub-123",
	}))
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	if slug, ok := reg.ProductFor("someone-else"); ok || slug != "" {
		t.Fatalf("ProductFor(someone-else) = %q, %v; want \"\", false", slug, ok)
	}
}

func TestAnEmptySubjectNeverResolves(t *testing.T) {
	// A principal with no subject must not match a product whose subject list
	// happened to contain an empty entry. Fails closed on the degenerate input,
	// matching hasCapability's stance in the capability vocabulary.
	reg, err := productscope.LoadRegistry(env(map[string]string{
		"PRODUCT_SCOPE_PRODUCTS":         "mark8ly",
		"PRODUCT_SCOPE_MARK8LY_SUBJECTS": "sub-123, ,sub-456",
	}))
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	if _, ok := reg.ProductFor(""); ok {
		t.Fatal("the empty subject resolved to a product")
	}
	// The real entries either side of the blank still load.
	for _, s := range []string{"sub-123", "sub-456"} {
		if _, ok := reg.ProductFor(s); !ok {
			t.Errorf("%s did not resolve", s)
		}
	}
}

func TestNoDeclarationMeansAnEmptyRegistryRatherThanAnError(t *testing.T) {
	// A deployment that scopes no product is legitimate — it is every
	// deployment today. It must boot, and grant nothing.
	reg, err := productscope.LoadRegistry(env(nil))
	if err != nil {
		t.Fatalf("an undeclared registry must not refuse to boot: %v", err)
	}
	if _, ok := reg.ProductFor("sub-123"); ok {
		t.Fatal("an empty registry resolved a subject")
	}
}

func TestADeclaredProductWithNoSubjectsIsRefusedAtBoot(t *testing.T) {
	// Same reasoning as FEDERATION_<SLUG>_SECRET: a product named in the
	// declaration but given no subject is a typo, not a configuration. It
	// would present at runtime as "this product's machine is never scoped",
	// which reads as a token problem rather than a config one.
	_, err := productscope.LoadRegistry(env(map[string]string{
		"PRODUCT_SCOPE_PRODUCTS": "mark8ly",
	}))
	if err == nil {
		t.Fatal("a declared product with no subjects was accepted")
	}
}

func TestASubjectClaimedByTwoProductsIsRefusedAtBoot(t *testing.T) {
	// The one genuinely dangerous misconfiguration: a subject mapping to two
	// products collapses in the reverse map and which product wins depends on
	// declaration order. That is a caller reading another product's tickets
	// because of the order someone typed an env var.
	_, err := productscope.LoadRegistry(env(map[string]string{
		"PRODUCT_SCOPE_PRODUCTS":          "mark8ly,homechef",
		"PRODUCT_SCOPE_MARK8LY_SUBJECTS":  "sub-shared",
		"PRODUCT_SCOPE_HOMECHEF_SUBJECTS": "sub-shared",
	}))
	if err == nil {
		t.Fatal("a subject claimed by two products was accepted")
	}
	if !errors.Is(err, productscope.ErrAmbiguousSubject) {
		t.Errorf("want ErrAmbiguousSubject, got %v", err)
	}
}

func TestARepeatedProductIsRefusedAtBoot(t *testing.T) {
	_, err := productscope.LoadRegistry(env(map[string]string{
		"PRODUCT_SCOPE_PRODUCTS":         "mark8ly,mark8ly",
		"PRODUCT_SCOPE_MARK8LY_SUBJECTS": "sub-123",
	}))
	if err == nil {
		t.Fatal("a repeated product slug was accepted")
	}
}
