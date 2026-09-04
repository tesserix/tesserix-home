// Package productscope answers WHICH product an authenticated machine speaks
// for.
//
// It exists because the other three candidates cannot answer it:
//
//   - Not the capability. Capabilities are estate-wide (§7) — there is no way
//     to say "mark8ly's tickets but not Kora's" in a role key, and inventing
//     one would put a per-product dimension into a fixed contract with
//     Zitadel's role list, where toCapabilities drops anything unrecognised.
//   - Not Principal.Kind. platform-auth/verify.go forbids authorising on it:
//     keeping caller CLASSIFICATION apart from caller ACCESS is what stops a
//     change to one silently becoming a change to the other (#450, #433).
//   - Not the request. A product supplying its own scope in a query parameter
//     is not a scope; it is a suggestion. That is precisely the hole #152
//     found in the tickets module.
//
// So scope comes from deployment configuration, keyed by the one thing the
// issuer attests and the caller cannot choose: its subject. The capability
// answers WHETHER a caller may reach a product's tickets; this answers WHICH
// product's. Neither is derivable from the other, and that is deliberate.
//
// The shape mirrors federation.Registry, including its central property: a
// product is scoped because it was NAMED in the declaration, not because some
// related variable happened to be set. Configuration left behind by a rollback
// cannot quietly re-enable one.
package productscope

import (
	"errors"
	"fmt"
	"strings"
)

// ErrAmbiguousSubject means one subject was claimed by more than one product.
//
// A distinct error because it is the one misconfiguration with a security
// consequence rather than an availability one: the reverse map would keep
// whichever product was declared last, so a caller would read another
// product's tickets because of the order someone typed an env var.
var ErrAmbiguousSubject = errors.New("productscope: subject is claimed by more than one product")

// Registry maps an attested subject to the product slug it speaks for.
type Registry struct {
	bySubject map[string]string
}

// NewRegistry builds a registry from an already-validated subject->slug map.
//
// LoadRegistry is the way in from configuration; this exists for tests and for
// callers assembling a registry from somewhere other than the environment.
func NewRegistry(bySubject map[string]string) *Registry {
	copied := make(map[string]string, len(bySubject))
	for subject, slug := range bySubject {
		copied[subject] = slug
	}
	return &Registry{bySubject: copied}
}

// ProductFor returns the product a subject speaks for.
//
// The bool is the whole contract, and it is why this does not return just a
// string: "not scoped to any product" must be impossible to confuse with a
// product whose slug happens to be empty. A caller that ignored it would
// scope every unmapped machine to "".
//
// The empty subject never resolves, even if a declaration contained a blank
// entry. A principal with no subject is a degenerate input, and this fails
// closed on it the way hasCapability does in the capability vocabulary.
func (r *Registry) ProductFor(subject string) (string, bool) {
	if r == nil || subject == "" {
		return "", false
	}
	slug, ok := r.bySubject[subject]
	return slug, ok
}

// LoadRegistry builds the registry from the environment.
//
// PRODUCT_SCOPE_PRODUCTS is the declaration and the whole mechanism, exactly as
// FEDERATION_PRODUCTS is for federation. PRODUCT_SCOPE_<SLUG>_SUBJECTS is the
// comma-separated list of Zitadel subjects that speak for that product — a
// list rather than a single value because a product may legitimately run more
// than one machine user (mark8ly already runs mark8ly-catalog-reader for the
// plan and promo catalogs).
//
// An absent declaration is a legitimate configuration and boots to an empty
// registry that scopes nobody. Every other malformed case refuses at boot,
// because each would present at runtime as an authorization symptom pointing
// at the token rather than at the config that actually caused it.
func LoadRegistry(getenv func(string) string) (*Registry, error) {
	declared := strings.TrimSpace(getenv("PRODUCT_SCOPE_PRODUCTS"))
	if declared == "" {
		return NewRegistry(nil), nil
	}

	bySubject := make(map[string]string)
	seenProduct := make(map[string]struct{})

	for _, raw := range strings.Split(declared, ",") {
		slug := strings.TrimSpace(raw)
		if slug == "" {
			continue
		}
		if _, duplicate := seenProduct[slug]; duplicate {
			return nil, fmt.Errorf(
				"productscope: product %q is declared more than once in PRODUCT_SCOPE_PRODUCTS",
				slug)
		}
		seenProduct[slug] = struct{}{}

		key := "PRODUCT_SCOPE_" + strings.ToUpper(slug) + "_SUBJECTS"
		subjects := splitSubjects(getenv(key))
		if len(subjects) == 0 {
			// As strict as FEDERATION_<SLUG>_SECRET, for the same reason: a
			// product named but given no subject is a typo, and its runtime
			// symptom would be "this product's machine is never scoped",
			// which reads as a bad token rather than a bad env var.
			return nil, fmt.Errorf(
				"productscope: product %q is declared in PRODUCT_SCOPE_PRODUCTS but %s is empty",
				slug, key)
		}

		for _, subject := range subjects {
			if existing, claimed := bySubject[subject]; claimed {
				return nil, fmt.Errorf("%w: %q is claimed by both %q and %q",
					ErrAmbiguousSubject, subject, existing, slug)
			}
			bySubject[subject] = slug
		}
	}

	return NewRegistry(bySubject), nil
}

// splitSubjects reads a comma-separated list, dropping blank entries.
//
// Blanks are dropped rather than rejected because a trailing comma is a typing
// artefact with no security consequence — ProductFor refuses the empty subject
// regardless, so a blank entry cannot become a matchable one.
func splitSubjects(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if s := strings.TrimSpace(part); s != "" {
			out = append(out, s)
		}
	}
	return out
}
