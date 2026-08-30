// Package service inverts this deployment's federation declarations into an
// index of "who declares what".
//
// # It reads declarations, and never asks a product anything
//
// Every other federating module in this service calls the products. This one
// does not, and cannot: the answer it gives is a fact about THIS deployment's
// configuration — what FEDERATION_<SLUG>_ENDPOINTS and _ENTITIES were set to —
// not a fact about any product's health. That is deliberate and it is the
// reason the route has no failure modes worth a status of their own: a source
// list that could not be read would mean the registry could not be read, and a
// registry that could not be read means the process did not boot.
//
// The consequence worth stating: a slug appearing here is a product that
// DECLARED an endpoint, not one that is currently answering. The two are
// different questions, and this route only answers the first. A console
// rendering a source picker from this list still meets a real failure when it
// asks the product for data — which is where such a failure belongs, because
// that is where it can be distinguished from an empty result.
//
// # Why the inversion happens here and not in federation
//
// Registry.SlugsImplementing already answers this one endpoint at a time, and
// the composition root could have called it once per endpoint name. It does
// not, because that requires a canonical list of endpoint NAMES kept somewhere
// — and a name missing from that list would answer "no product declares this"
// for an endpoint several products declare, which is the exact under-report
// registry.go's absence-means-no rule warns about, moved one level up.
//
// Inverting the declarations instead needs no vocabulary at all. A key exists
// here because a product declared it, so the index cannot disagree with the
// registry about what was declared; it is the same data read from the other
// side.
package service

import "sort"

// Index is the whole answer: two inverted maps, endpoint or entity type to the
// products declaring it.
//
// Both are ALWAYS non-nil, including on a deployment that federates nothing —
// see New. `data.endpoints.onboarding` against a JSON null is a TypeError in
// the console, and a page that crashes on an empty estate is worse than one
// that shows an empty picker.
type Index struct {
	// Endpoints is FEDERATION_<SLUG>_ENDPOINTS, inverted: `onboarding` maps to
	// every product declaring it.
	Endpoints map[string][]string `json:"endpoints"`
	// Entities is FEDERATION_<SLUG>_ENTITIES, inverted the same way. Included
	// because it is the same question about §3.4's product-defined types —
	// "which products can I ask for tenants" — and a second route for it would
	// be the per-endpoint proliferation the package doc argues against.
	Entities map[string][]string `json:"entities"`
}

// Service holds one deployment's declarations, by product slug.
type Service struct {
	endpoints map[string][]string
	entities  map[string][]string
}

// New takes the declarations as plain maps rather than []federation.Product.
//
// Not a stylistic choice: federation.Product carries the product's HMAC
// Secret, and this module's entire job is to marshal what it is given into a
// JSON response. Taking a type that cannot hold a secret is what makes leaking
// one impossible here rather than merely unlikely.
func New(endpoints, entities map[string][]string) *Service {
	return &Service{endpoints: endpoints, entities: entities}
}

// Index builds the answer. Cheap enough to do per request — the registry is
// fixed at boot and holds a handful of products — and doing it per request
// rather than once at construction keeps the service from holding a second
// copy of a fact that already lives in the registry.
func (s *Service) Index() Index {
	return Index{
		Endpoints: invert(s.endpoints),
		Entities:  invert(s.entities),
	}
}

// invert turns slug→declarations into declaration→slugs.
//
// Slugs are sorted for the reason Registry.Slugs sorts: a picker renders them
// in order, and an unstable order makes two identical deployments look like
// different ones. Duplicates are collapsed because " onboarding, onboarding "
// in an env var is a typo, not two products.
func invert(declarations map[string][]string) map[string][]string {
	// Non-nil unconditionally: an estate federating nothing must marshal to
	// {} and never null. See Index.
	out := make(map[string][]string)
	seen := make(map[string]map[string]struct{})
	for slug, declared := range declarations {
		for _, name := range declared {
			if _, duplicate := seen[name][slug]; duplicate {
				continue
			}
			if seen[name] == nil {
				seen[name] = make(map[string]struct{})
			}
			seen[name][slug] = struct{}{}
			out[name] = append(out[name], slug)
		}
	}
	for name := range out {
		sort.Strings(out[name])
	}
	return out
}
