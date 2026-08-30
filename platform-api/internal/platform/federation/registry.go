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
	// Entities is the §3.4 entity types this product serves — `tenants`,
	// `users`, `foods`. Product-defined, because `{type}` is: kora serving
	// users and foods does not mean it has tenants, and asking it for them
	// would produce a 404 reported to an operator as a failed source.
	//
	// OPTIONAL, unlike BaseURL and Secret. A product that federates audit logs
	// and serves no entity type is a normal configuration. Absence means it
	// serves none — the same absence-means-no rule FEDERATION_PRODUCTS uses,
	// so a product stays out of an entity surface until someone declares it
	// in rather than until someone remembers to exclude it.
	Entities []string
	// Endpoints is the OPTIONAL contract endpoints this product implements
	// beyond the ones every federating product serves — today only `inbox`.
	//
	// Needed for the same reason Entities is, one level up. §3.2 is a required
	// contract endpoint, but "required" governs products that adopt it, not
	// every product at once: a product that does not mount a contract route
	// answers 404, and an operator sees a failed source where the honest
	// answer is that the product does not serve it.
	//
	// THE EXAMPLE THIS USED TO GIVE HAS EXPIRED. It said "mark8ly does not
	// mount /admin/inbox at all". It does — probed in production on
	// 2026-08-30, `GET /admin/inbox` answers 401 (mounted, signature
	// rejected) against a control 404 for a made-up path under the same
	// prefix, and tesserix/mark8ly#415 ("admin-conformance.json does not
	// declare inbox, which is mounted and working") is closed. mark8ly is
	// still not DECLARED here for `inbox`, which is a separate and deliberate
	// choice — tesserix-home#406 put its fast-path queue on mark8ly's own
	// product rail rather than the estate Inbox, because the review step
	// presupposes mark8ly's migration model in a way "what is waiting on a
	// human" does not. Declaring it would fan the estate Inbox out to that
	// queue, which is a product decision, not a wiring one.
	//
	// Absence means it implements none — the same absence-means-no rule
	// FEDERATION_PRODUCTS and ENTITIES use. A product stays out of the estate
	// queue until someone declares it in, rather than until someone remembers
	// to exclude it. That direction is the safe one: an under-declared product
	// is a visibly missing source, an over-declared one is a permanent red
	// failure on a surface operators are meant to trust.
	Endpoints []string
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

// SlugsServing is every product declaring the given §3.4 entity type, sorted
// for the same reason Slugs is.
//
// The caller is a module that reads one entity type across the estate; it must
// not simply fan out over Slugs(), because a product without that type answers
// 404 and the operator sees a failed source where the honest answer is that
// the product has none.
func (r *Registry) SlugsServing(entity string) []string {
	out := make([]string, 0, len(r.byslug))
	for slug, p := range r.byslug {
		for _, e := range p.Entities {
			if e == entity {
				out = append(out, slug)
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

// SlugsImplementing is every product declaring the given contract endpoint,
// sorted for the same reason Slugs is.
//
// Distinct from SlugsServing, which answers a different question: that one is
// about §3.4's product-defined entity TYPES beneath a single endpoint, this
// one is about whether an endpoint exists at all.
func (r *Registry) SlugsImplementing(endpoint string) []string {
	out := make([]string, 0, len(r.byslug))
	for slug, p := range r.byslug {
		for _, e := range p.Endpoints {
			if e == endpoint {
				out = append(out, slug)
				break
			}
		}
	}
	sort.Strings(out)
	return out
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
			// Optional. Empty means this product serves no entity type, which
			// is why this is not checked the way BASE_URL and SECRET are: an
			// absent declaration is a legitimate configuration, not a typo.
			Entities: splitList(getenv(prefix + "ENTITIES")),
			// Optional, for the same reason Entities is: a product that
			// federates audit logs and implements no further endpoint is a
			// normal configuration, not a typo.
			Endpoints: splitList(getenv(prefix + "ENDPOINTS")),
		})
	}
	return NewRegistry(products), nil
}

// splitList parses a comma-separated env value, trimming each element and
// dropping empties, so " tenants , users " and "tenants,users" agree.
func splitList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
