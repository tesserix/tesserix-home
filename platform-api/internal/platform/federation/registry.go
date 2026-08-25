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
	//
	// For mark8ly this must end in "/api/v1/platform", NOT "/api/v1". The
	// difference is not cosmetic and does not fail anywhere you would look:
	// an Istio AuthorizationPolicy in istio-ingress denies un-JWT'd requests
	// to /api/v1/admin/*, and this surface authenticates by HMAC rather than
	// by JWT. Point it at the wrong prefix and the mesh answers 403
	// "RBAC: access denied" before the request reaches the application — so
	// the product's own logs show nothing, and neither local dev nor CI
	// reproduces it, because Istio is in neither.
	BaseURL string
	// Secret is the HMAC key the request is signed with. See signature.go —
	// it is the key, not a bearer credential, and is never sent.
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
	seen := make(map[string]struct{})
	for _, raw := range strings.Split(declared, ",") {
		slug := strings.TrimSpace(raw)
		if slug == "" {
			continue
		}
		// A repeated slug would collapse silently in NewRegistry's map — last
		// declaration wins, and which one that is depends on the order someone
		// typed an env var in. This file is the estate's blast-radius control;
		// a product whose coordinates are decided by a typo is not a control.
		if _, duplicate := seen[slug]; duplicate {
			return nil, fmt.Errorf(
				"federation: product %q is declared more than once in FEDERATION_PRODUCTS",
				slug)
		}
		seen[slug] = struct{}{}

		prefix := "FEDERATION_" + strings.ToUpper(slug) + "_"
		base := strings.TrimSpace(getenv(prefix + "BASE_URL"))
		if base == "" {
			return nil, fmt.Errorf(
				"federation: product %q is declared in FEDERATION_PRODUCTS but %sBASE_URL is empty",
				slug, prefix)
		}
		// Exactly as strict as BASE_URL, and for a stronger reason. An empty
		// secret is not a missing feature: it is a key that signs nothing, so
		// a typo'd FEDERATION_<SLUG>_SECRET would make every federated call
		// fail authentication at the far end with no local symptom beyond a
		// 401. Sign refuses an empty secret too; this is the earlier of the
		// two gates, and it fails closed at boot rather than per request.
		secret := strings.TrimSpace(getenv(prefix + "SECRET"))
		if secret == "" {
			return nil, fmt.Errorf(
				"federation: product %q is declared in FEDERATION_PRODUCTS but %sSECRET is empty",
				slug, prefix)
		}
		products = append(products, Product{
			Slug:    slug,
			BaseURL: strings.TrimRight(base, "/"),
			Secret:  secret,
		})
	}
	return NewRegistry(products), nil
}
