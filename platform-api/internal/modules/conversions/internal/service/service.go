// Package service asks one product whether a lead email has converted, and
// forwards the product's answer verbatim.
//
// # Why this does not model the answer
//
// The console already has a strict reader for this wire shape —
// `parseConversionBody` in apps/console/lib/crm-conversion.ts — written
// against the contract and enforcing Ruling 28. A Go struct here would be a
// SECOND reader of the same contract, and the two would drift the first time
// mark8ly adds a field: re-marshalling from a struct drops what it has never
// heard of, silently, and the console would render a narrower answer than the
// product gave. Same argument as onboardingfunnel's, and §8.9's cautionary
// tale about an entity row that quietly dropped `sublabel`.
//
// So Read returns the product's bytes. This layer decides only ONE thing: did
// a trustworthy answer arrive at all.
//
// # The one invariant it does enforce, and why it is not modelling
//
// A 200 must carry a `state` that is one of the contract's three. That is not
// an enumeration this layer owns — it is the difference between "the product
// answered" and "something else answered", and getting it wrong is the single
// failure this whole module exists to prevent.
//
// `none` means "the product answered, and this person has not converted". If a
// 502 from a gateway, an HTML error page, or a body with no state could reach
// the console, the console's own parser would refuse it and report `unknown` —
// so the console is not actually at risk. What IS at risk is the operator's
// read of the Handoff queue: a merchant who is genuinely live sitting under a
// signal we could not obtain is the bug the contract's `unknown`/`none` split
// exists to prevent, and it is cheaper to refuse here than to explain later.
//
// The `state` VALUES are checked, not the ref/label/observed_at fields. Those
// are the product's own vocabulary and pass through untouched.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is mark8ly's own admin route — `ConversionsHandler.Register` in
// services/marketplace-api/internal/handlers/platformadmin/conversions.go —
// not a §3 contract endpoint. Which is why this module reads
// SlugsImplementing("conversions") rather than every federated product.
const productPath = "/admin/conversions"

// wireStates is the contract's three. `unknown` is deliberately absent: it is
// the CONSOLE's fourth state for "we could not find out", and a product
// claiming it would be asserting our uncertainty on our behalf.
var wireStates = map[string]bool{"none": true, "in_flight": true, "complete": true}

// ErrNoProducts is the answer when no product on this deployment declares
// conversions at all. Distinct from every failure below: it is fixed with a
// FEDERATION_<SLUG>_ENDPOINTS entry, not by anyone looking at a product.
var ErrNoProducts = errors.New("conversions: no product declares conversions")

// ErrUnknownSource is a product this deployment cannot ask — either not
// federated, or federated without declaring `conversions`.
var ErrUnknownSource = errors.New("conversions: unknown source")

// ErrNoConversions is the product answering 404: the route is not mounted. For
// mark8ly that is `deps.TenantDirectory == nil`.
//
// Reaching this means the product DECLARED `conversions` and then did not
// serve it — the over-declaration registry.go warns about. Kept distinct from
// ErrNotImplemented so whoever debugs it can tell "not mounted" from
// "declined".
var ErrNoConversions = errors.New("conversions: the product does not mount conversions")

// ErrNotImplemented is the product answering 501: the route exists and
// declines.
var ErrNotImplemented = errors.New("conversions: the product reports no conversions")

// ErrUnreadable is a 200 whose body is not a conversion answer. Deliberately
// an error and not a degraded success — see the package doc.
var ErrUnreadable = errors.New("conversions: the answer could not be read")

// Service asks one product about one email.
type Service struct {
	fed   *federation.Client
	slugs []string
	log   *slog.Logger
}

// New builds the service. log is required: a federated failure is logged with
// its unredacted cause before being reported as a sanitised error.
func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// Read asks source whether email has converted, and returns the product's
// answer unparsed.
//
// There is no fan-out: the caller already knows which product an opportunity
// belongs to, and "has this email converted, anywhere" is a different question
// with no consumer today. See onboardingfunnel's Read for the same argument at
// length.
func (s *Service) Read(
	ctx context.Context, op federation.Operator, source, email string,
) (json.RawMessage, error) {
	if len(s.slugs) == 0 {
		return nil, ErrNoProducts
	}
	if !contains(s.slugs, source) {
		return nil, fmt.Errorf("%w: %s", ErrUnknownSource, source)
	}

	// Encoded, never concatenated. A `+` in an address is a real character
	// that a bare query string turns into a space, which would ask the product
	// about a DIFFERENT person and answer confidently about them.
	path := productPath + "?" + url.Values{"email": {email}}.Encode()

	body, err := s.fed.Get(ctx, source, path, op)
	if err != nil {
		// 404 and 501 are contract statements and stay distinguishable.
		// Everything else — 5xx, 401, DNS, TLS, timeout — is the product
		// failing to answer, and must never arrive anywhere as a conversion.
		if status, ok := federation.StatusOf(err); ok {
			switch status {
			case http.StatusNotFound:
				return nil, fmt.Errorf("%w: %s", ErrNoConversions, source)
			case http.StatusNotImplemented:
				return nil, fmt.Errorf("%w: %s", ErrNotImplemented, source)
			}
		}
		s.log.Error("conversions: federated read failed", "source", source, "error", err)
		return nil, fmt.Errorf("reading %s conversion: %w", source, err)
	}

	// Only `state` is decoded, and only to decide whether an answer arrived.
	// Every other field stays bytes — see the package doc.
	var envelope struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("%w: decoding %s: %v", ErrUnreadable, source, err)
	}
	if !wireStates[envelope.State] {
		return nil, fmt.Errorf(
			"%w: %s returned state %q, which is not one of the contract's three",
			ErrUnreadable, source, envelope.State)
	}

	// The original bytes, not a re-marshal: what the console parses is
	// byte-for-byte what the product said.
	return body, nil
}

func contains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}
