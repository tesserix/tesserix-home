// Package federation calls other products' platform admin APIs on behalf of an
// operator.
//
// It is kernel, not a module: several modules (audit now; tenants, billing,
// compliance later) all need the same client, and a module may not import
// another module. See docs/PLATFORM-API-CONVENTIONS.md §8.
package federation

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
)

// Service is one callable front door — one base URL, one HMAC secret, and
// what it serves.
//
// A product used to be exactly one of these, back when mark8ly had exactly
// one platform-admin front door. It now has two — marketplace-api and
// platform-api (tesserix/mark8ly#720) — and console-core still keys ESTATE on
// product, not on front door: an operator thinks of both as parts of mark8ly,
// not as peers of it. So the map moved one level down, from Registry keying
// straight to coordinates, to Registry keying to a Product that fans out
// across its Services. See Product.
type Service struct {
	// Name identifies this service within its product — "marketplace-api",
	// "platform-api". It is what FEDERATION_<SLUG>_SERVICES names and,
	// uppercased with "-" turned into "_", the env prefix
	// FEDERATION_<SLUG>_<SERVICE>_* is built from. It has no meaning outside
	// its product: two products may each have a service named "platform-api"
	// without colliding, because every lookup is (slug, name).
	Name string
	// BaseURL is this service's platform admin front door, without a trailing
	// slash.
	//
	// For mark8ly's platform-api service this must end in "/api/v1/platform",
	// NOT "/api/v1". The difference is not cosmetic and does not fail
	// anywhere you would look: an Istio AuthorizationPolicy in istio-ingress
	// denies un-JWT'd requests to /api/v1/admin/*, and this surface
	// authenticates by HMAC rather than by JWT. Point it at the wrong prefix
	// and the mesh answers 403 "RBAC: access denied" before the request
	// reaches the application — so the product's own logs show nothing, and
	// neither local dev nor CI reproduces it, because Istio is in neither.
	BaseURL string
	// Secret is the HMAC key the request is signed with. See signature.go —
	// it is the key, not a bearer credential, and is never sent.
	Secret string
	// Entities is the §3.4 entity types this service serves — `tenants`,
	// `users`, `foods`. Service-defined, because `{type}` is: a service
	// serving users and foods does not mean it has tenants, and asking it for
	// them would produce a 404 reported to an operator as a failed source.
	//
	// OPTIONAL, unlike BaseURL and Secret. A service that federates audit logs
	// and serves no entity type is a normal configuration. Absence means it
	// serves none — the same absence-means-no rule FEDERATION_PRODUCTS uses,
	// so a service stays out of an entity surface until someone declares it
	// in rather than until someone remembers to exclude it.
	//
	// Two services of one product MAY declare the same entity type — that is
	// the expected shape for a split surface, not a config error. See
	// Registry.ServicesServing.
	Entities []string
	// Endpoints is the OPTIONAL contract endpoints this service implements
	// beyond the ones every federating product serves — today only `inbox`.
	//
	// Needed for the same reason Entities is, one level up. §3.2 is a required
	// contract endpoint, but "required" governs products that adopt it, not
	// every product at once: a service that does not mount a contract route
	// answers 404, and an operator sees a failed source where the honest
	// answer is that it does not serve it.
	//
	// Two services of one product MAY implement the same endpoint. This is
	// not a hypothetical: mark8ly's email-template registry is split across
	// its two services — marketplace-api owns the order/billing keys,
	// platform-api owns the auth keys (welcome, email_verification,
	// invitation, password_reset, login_otp, new_device_login) — so BOTH
	// declare `email-templates`, and the console must see both halves.
	// Rejecting the second declaration at boot, which an earlier version of
	// this file did, would make that split unimplementable. See
	// Registry.ServicesImplementing, which is why the map can hold this at
	// all.
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
	// FEDERATION_PRODUCTS and ENTITIES use. A service stays out of the estate
	// queue until someone declares it in, rather than until someone remembers
	// to exclude it. That direction is the safe one: an under-declared
	// service is a visibly missing source, an over-declared one is a
	// permanent red failure on a surface operators are meant to trust.
	Endpoints []string
}

// Product is one product's coordinates: the slug an operator thinks of as
// one thing, and the one or more Services callable under it.
//
// Slug is keyed on product rather than on front door on purpose — see
// Service's doc comment. A third service (`otto`, contingent on
// tesserix/mark8ly#330) fits the same shape: another element of Services,
// nothing structural.
type Product struct {
	// Slug is the product's identity across the estate — the same value
	// console-core's EstateProduct.context carries.
	Slug string
	// Services is this product's callable front doors, in declaration order
	// (the order FEDERATION_<SLUG>_SERVICES named them, or a single
	// synthesized entry for the legacy shape — see LoadRegistry).
	Services []Service
}

// Entities is the union of every service's Entities, sorted and deduplicated.
//
// This is what keeps SlugsServing working unchanged now that a product can
// have more than one service: it asks "does this product serve this entity
// type at all", which is exactly the union. A caller that needs to know
// WHICH service, rather than whether the product does at all, wants
// Registry.ServicesServing instead.
func (p Product) Entities() []string {
	return unionSorted(func(yield func(string)) {
		for _, svc := range p.Services {
			for _, e := range svc.Entities {
				yield(e)
			}
		}
	})
}

// Endpoints is the union of every service's Endpoints, sorted and
// deduplicated. See Entities — the same reasoning applies one level up.
func (p Product) Endpoints() []string {
	return unionSorted(func(yield func(string)) {
		for _, svc := range p.Services {
			for _, e := range svc.Endpoints {
				yield(e)
			}
		}
	})
}

// unionSorted collects every string a producer yields, deduplicates and
// sorts it. Used by Entities and Endpoints so both agree on tie-breaking —
// sorted for the same reason Slugs is: an unstable order makes two identical
// configurations look like different ones to a diff-based reviewer.
func unionSorted(produce func(yield func(string))) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0)
	produce(func(s string) {
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	})
	sort.Strings(out)
	return out
}

// soleService is a product's one service, for a caller — Client.do today —
// that has no entity or endpoint context to pick between several with.
//
// Every product configured today has exactly one service (see LoadRegistry's
// legacy path), so this covers every real deployment. A product configured
// with more than one gets ok=false: Client.do fails closed rather than
// guessing, because guessing here means silently calling the wrong front
// door with the wrong secret. Resolving correctly needs
// Registry.ServicesServing / ServicesImplementing, which needs the entity or
// endpoint the call is for — context Client.do is not, today, given. That is
// a real gap, tracked for whoever wires a second real multi-service product
// in and needs the call sites to close it, not something this type can paper
// over.
func (p Product) soleService() (Service, bool) {
	if len(p.Services) != 1 {
		return Service{}, false
	}
	return p.Services[0], true
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

// ServicesServing is every service, across every product, that declares the
// given §3.4 entity type — for a caller that already has Get(slug) and a
// BaseURL/Secret, and now needs the specific service (or services) to call
// instead of assuming a product has exactly one.
//
// It returns every match, not the first: two services of one product MAY
// both declare the same entity, and that is the expected shape for a split
// surface (see Service.Endpoints), not an ambiguity to resolve down to one.
// The caller fans out across everything returned and merges — the same
// pattern FanOut already uses across products, one level down to services.
//
// Sorted by (product slug, service name) so a fan-out's failure list stays
// stable across runs — the same reason Slugs is sorted: an unstable order
// makes two identical outages look like different ones.
func (r *Registry) ServicesServing(entity string) []Service {
	return r.servicesWhere(func(svc Service) bool {
		for _, e := range svc.Entities {
			if e == entity {
				return true
			}
		}
		return false
	})
}

// ServicesImplementing is every service, across every product, that declares
// the given contract endpoint. See ServicesServing — everything there applies
// here, one level removed from entity types to endpoints.
func (r *Registry) ServicesImplementing(endpoint string) []Service {
	return r.servicesWhere(func(svc Service) bool {
		for _, e := range svc.Endpoints {
			if e == endpoint {
				return true
			}
		}
		return false
	})
}

// servicesWhere is what ServicesServing and ServicesImplementing share, so
// the sort and the traversal cannot drift between the two.
func (r *Registry) servicesWhere(match func(Service) bool) []Service {
	slugs := make([]string, 0, len(r.byslug))
	for slug := range r.byslug {
		slugs = append(slugs, slug)
	}
	sort.Strings(slugs)

	out := make([]Service, 0)
	for _, slug := range slugs {
		p := r.byslug[slug]
		names := make([]string, 0, len(p.Services))
		byName := make(map[string]Service, len(p.Services))
		for _, svc := range p.Services {
			if match(svc) {
				names = append(names, svc.Name)
				byName[svc.Name] = svc
			}
		}
		sort.Strings(names)
		for _, name := range names {
			out = append(out, byName[name])
		}
	}
	return out
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
		for _, e := range p.Entities() {
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
		for _, e := range p.Endpoints() {
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
//
// Each declared product is either the legacy single-service shape —
// FEDERATION_<SLUG>_BASE_URL / _SECRET / _ENTITIES / _ENDPOINTS define its one
// service — or, if FEDERATION_<SLUG>_SERVICES is present, a named service per
// entry, each with its own FEDERATION_<SLUG>_<SERVICE>_BASE_URL / _SECRET /
// _ENTITIES / _ENDPOINTS (<SERVICE> is the name uppercased with "-" turned
// into "_", so "platform-api" reads FEDERATION_MARK8LY_PLATFORM_API_*).
// SERVICES is OPTIONAL and additive: a product that never sets it behaves
// exactly as it did before this type existed, which is required, not just
// convenient — kora has no reason to ever need a second service, and must
// keep working with zero configuration change.
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
		services, err := loadServices(getenv, slug, prefix)
		if err != nil {
			return nil, err
		}
		products = append(products, Product{Slug: slug, Services: services})
	}
	return NewRegistry(products), nil
}

// loadServices builds one product's Services, either from the legacy flat
// shape or from FEDERATION_<SLUG>_SERVICES. Split out of LoadRegistry so the
// two shapes' parsing does not tangle with the FEDERATION_PRODUCTS loop above
// it.
func loadServices(getenv func(string) string, slug, prefix string) ([]Service, error) {
	productBase := strings.TrimSpace(getenv(prefix + "BASE_URL"))
	productSecret := strings.TrimSpace(getenv(prefix + "SECRET"))
	serviceNames := splitList(getenv(prefix + "SERVICES"))

	if len(serviceNames) == 0 {
		// The legacy shape: the product-level keys ARE its one service. This
		// is the compatibility case every product deployed before #720 relies
		// on, and it must produce exactly what this function produced before
		// SERVICES existed.
		if productBase == "" {
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
		if productSecret == "" {
			return nil, fmt.Errorf(
				"federation: product %q is declared in FEDERATION_PRODUCTS but %sSECRET is empty",
				slug, prefix)
		}
		return []Service{{
			Name:    slug,
			BaseURL: strings.TrimRight(productBase, "/"),
			Secret:  productSecret,
			// Optional. Empty means this service serves no entity type, which
			// is why this is not checked the way BASE_URL and SECRET are: an
			// absent declaration is a legitimate configuration, not a typo.
			Entities: splitList(getenv(prefix + "ENTITIES")),
			// Optional, for the same reason Entities is: a service that
			// federates audit logs and implements no further endpoint is a
			// normal configuration, not a typo.
			Endpoints: splitList(getenv(prefix + "ENDPOINTS")),
		}}, nil
	}

	// SERVICES is present. The env for this product was deployed before this
	// code (k8s-first), so there is necessarily a window where the k8s chart
	// carries BOTH the new per-service keys AND the old product-level ones.
	// Warn, don't fail: failing on both-present would make that rollout
	// order — the only order this estate's Kargo/ArgoCD pipeline supports —
	// undeployable. Ignoring silently is how this estate has lost config
	// before; naming the exact variables being ignored is what a warning
	// costs to prevent that.
	if productBase != "" || productSecret != "" {
		var ignored []string
		if productBase != "" {
			ignored = append(ignored, prefix+"BASE_URL")
		}
		if productSecret != "" {
			ignored = append(ignored, prefix+"SECRET")
		}
		slog.Warn("federation: product-level BASE_URL/SECRET are set alongside SERVICES and will be ignored",
			slog.String("product", slug),
			slog.Any("ignored_vars", ignored))
	}

	seenService := make(map[string]struct{}, len(serviceNames))
	services := make([]Service, 0, len(serviceNames))
	for _, name := range serviceNames {
		// A repeated service name has the same failure mode a repeated
		// product slug does — see FEDERATION_PRODUCTS above — and deserves
		// the same answer: a startup error naming both the product and the
		// service, not a silent last-wins collapse.
		if _, duplicate := seenService[name]; duplicate {
			return nil, fmt.Errorf(
				"federation: product %q declares service %q more than once in %sSERVICES",
				slug, name, prefix)
		}
		seenService[name] = struct{}{}

		svcPrefix := prefix + strings.ToUpper(strings.ReplaceAll(name, "-", "_")) + "_"
		base := strings.TrimSpace(getenv(svcPrefix + "BASE_URL"))
		if base == "" {
			return nil, fmt.Errorf(
				"federation: product %q service %q is declared in %sSERVICES but %sBASE_URL is empty",
				slug, name, prefix, svcPrefix)
		}
		secret := strings.TrimSpace(getenv(svcPrefix + "SECRET"))
		if secret == "" {
			return nil, fmt.Errorf(
				"federation: product %q service %q is declared in %sSERVICES but %sSECRET is empty",
				slug, name, prefix, svcPrefix)
		}
		services = append(services, Service{
			Name:      name,
			BaseURL:   strings.TrimRight(base, "/"),
			Secret:    secret,
			Entities:  splitList(getenv(svcPrefix + "ENTITIES")),
			Endpoints: splitList(getenv(svcPrefix + "ENDPOINTS")),
		})
	}
	return services, nil
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
