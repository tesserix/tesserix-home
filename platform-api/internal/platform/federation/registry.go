// Package federation calls other products' platform admin APIs on behalf of an
// operator.
//
// It is kernel, not a module: several modules (audit now; tenants, billing,
// compliance later) all need the same client, and a module may not import
// another module. See docs/PLATFORM-API-CONVENTIONS.md §8.
package federation

import (
	"fmt"
	"sort"
	"strings"
)

// Product is one callable product's coordinates.
type Product struct {
	// Slug is the product's identity across the estate — the same value
	// console-core's EstateProduct.context carries.
	Slug string
	// BaseURL is the product's platform admin front door, without a trailing
	// slash.
	BaseURL string
	// Secret is the shared secret the request is signed with.
	Secret string
}

// Registry is the set of products this deployment may call.
type Registry struct {
	byslug map[string]Product
}

func NewRegistry(products []Product) *Registry {
	byslug := make(map[string]Product, len(products))
	for _, p := range products {
		byslug[p.Slug] = p
	}
	return &Registry{byslug: byslug}
}

// Get fails closed: an unknown product is not callable, and "we have never
// heard of this product" and "this product is not configured" deserve the same
// answer.
func (r *Registry) Get(slug string) (Product, bool) {
	p, ok := r.byslug[slug]
	return p, ok
}

// Slugs is sorted so a fan-out's failure list is stable across runs. An
// unstable order makes two identical outages look like different ones.
func (r *Registry) Slugs() []string {
	out := make([]string, 0, len(r.byslug))
	for slug := range r.byslug {
		out = append(out, slug)
	}
	sort.Strings(out)
	return out
}

// LoadRegistry builds the registry from the environment.
//
// FEDERATION_PRODUCTS is the declaration, and it is the whole mechanism:
// a product is callable because it was named there, not because its URL
// happens to be set. Configuration left behind by a rollback cannot quietly
// re-enable a product.
func LoadRegistry(getenv func(string) string) (*Registry, error) {
	declared := strings.TrimSpace(getenv("FEDERATION_PRODUCTS"))
	if declared == "" {
		return NewRegistry(nil), nil
	}

	var products []Product
	for _, raw := range strings.Split(declared, ",") {
		slug := strings.TrimSpace(raw)
		if slug == "" {
			continue
		}
		prefix := "FEDERATION_" + strings.ToUpper(slug) + "_"
		base := strings.TrimSpace(getenv(prefix + "BASE_URL"))
		if base == "" {
			return nil, fmt.Errorf(
				"federation: product %q is declared in FEDERATION_PRODUCTS but %sBASE_URL is empty",
				slug, prefix)
		}
		products = append(products, Product{
			Slug:    slug,
			BaseURL: strings.TrimRight(base, "/"),
			Secret:  strings.TrimSpace(getenv(prefix + "SECRET")),
		})
	}
	return NewRegistry(products), nil
}
