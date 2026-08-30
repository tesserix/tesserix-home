// Package service reads one product's onboarding funnel and forwards it
// verbatim.
//
// # Why this does not model the funnel
//
// tesserix-home#404's first rule: mark8ly's own stage vocabulary is rendered
// verbatim, because a console-side enumeration of funnel stages is a second
// vocabulary that drifts from the first. A fixed Go struct here would BE that
// second vocabulary — the moment mark8ly adds a stage, this layer would drop
// it on the floor and nobody would see a gap, only a funnel that quietly
// stopped adding up. That is §8.9's cautionary tale exactly: an entity row
// modelled off a product's response silently dropped `sublabel`, and it took a
// users directory rendering two people identically before anyone noticed.
//
// So Read returns mark8ly's `data` object as raw bytes. The stage names, their
// order, and any stage this module has never heard of pass through untouched.
//
// # What it DOES check, and why those checks are not modelling
//
// Two invariants, neither of which names a stage:
//
//  1. `data` must be a non-empty JSON object. §8.6's envelope amendment aside,
//     this is the load-bearing half of #404's second rule — "a stage with zero
//     is a measurement; a funnel that could not be read is not". `{}` decodes
//     one layer down as every stage being zero, which reads to an operator as
//     "nobody signed up". A funnel we could not read must never be
//     representable as a funnel of zeros, so an empty object is an error.
//
//  2. `median_completion_seconds` must be PRESENT, though it may be null.
//     Null means "no session in the window completed, so there is no median" —
//     a distinct, representable state. An ABSENT key is the one shape that
//     collapses that state into 0: `stats.median ?? 0` on the console renders
//     "instant completion" for a funnel nobody finished. Requiring the key is
//     enforcing the nullability invariant the vocabulary is carried inside,
//     not enumerating the vocabulary itself. mark8ly's funnelRow already
//     declares it with no omitempty for precisely this reason.
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

// productPath is mark8ly's own admin route (its platformadmin handler mounts
// it behind `deps.OnboardingFunnel != nil`), not a §3 contract endpoint. Which
// is why this module reads SlugsImplementing("onboarding") rather than every
// federated product — see the package doc on onboardingfunnel.
const productPath = "/admin/onboarding/funnel"

// medianKey is the one key this layer looks for by name. See the package doc:
// its PRESENCE is a nullability invariant, not a stage in the vocabulary.
const medianKey = "median_completion_seconds"

// ErrNoProducts is the answer when no product on this deployment declares an
// onboarding funnel at all. Distinct from every failure below: "nothing is
// declared" is fixed with a FEDERATION_<SLUG>_ENDPOINTS entry, not by anyone
// looking at a product.
var ErrNoProducts = errors.New("onboardingfunnel: no product declares an onboarding funnel")

// ErrUnknownSource is a source naming a product this deployment cannot call
// for a funnel — either not federated at all, or federated without declaring
// `onboarding`.
var ErrUnknownSource = errors.New("onboardingfunnel: unknown source")

// ErrNoFunnel is the product answering 404: the route is not mounted. For
// mark8ly that is `deps.OnboardingFunnel == nil` — the funnel client was not
// wired, in practice a missing platform-api base URL or secret.
//
// Reaching this at all means the product DECLARED `onboarding` and then did
// not serve it: the over-declaration registry.go warns about, which is a
// permanent red source rather than a visibly missing one. Kept distinct from
// ErrNotImplemented so whoever debugs it can tell "not mounted" from
// "declined", instead of the proxy collapsing both into one answer.
var ErrNoFunnel = errors.New("onboardingfunnel: the product does not mount a funnel")

// ErrNotImplemented is the product answering 501: the route exists and
// declines. Kept distinct from ErrNoFunnel for the same reason.
var ErrNotImplemented = errors.New("onboardingfunnel: the product reports no funnel")

// ErrUnreadable is a 200 whose body does not satisfy the two invariants in the
// package doc. Deliberately an error and not a degraded success: this is the
// sentinel that keeps "we could not read the funnel" from ever wearing the
// clothes of "the funnel is all zeros".
var ErrUnreadable = errors.New("onboardingfunnel: the funnel could not be read")

// Service reads one product's onboarding funnel.
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

// Read fetches one product's funnel and returns its `data` object unparsed.
//
// # There is no fan-out, deliberately
//
// The console surface this feeds sits on the platform rail, because "where do
// signups stall" is a question every product with onboarding has. That is
// about where the PAGE lives; it is not a licence to merge funnels here.
// Merging two products' funnels requires a third vocabulary that is neither
// product's — the exact thing #404's first rule forbids — and with one
// implementer there is no evidence about what that third vocabulary should
// be. §8.8/§8.9's argument applies unchanged: a shape designed against no real
// consumer is designed wrong.
//
// The trigger to revisit: a second product declaring `onboarding`. At that
// point there are two real vocabularies to reconcile and the question becomes
// answerable from evidence rather than from imagination. The declaration
// mechanism is already in place (Registry.SlugsImplementing), so only the
// merge would be new work.
//
// query is forwarded exactly as received; the handler has already narrowed it
// to the window parameters mark8ly reads. It is not interpreted here — the
// response echoes the EFFECTIVE window back, and that echo is only true if
// this layer did not quietly rewrite what it asked for.
func (s *Service) Read(
	ctx context.Context, op federation.Operator, source string, query url.Values,
) (json.RawMessage, error) {
	if len(s.slugs) == 0 {
		return nil, ErrNoProducts
	}
	if !contains(s.slugs, source) {
		return nil, fmt.Errorf("%w: %s", ErrUnknownSource, source)
	}

	path := productPath
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}

	body, err := s.fed.Get(ctx, source, path, op)
	if err != nil {
		// 404 and 501 are contract statements and stay distinguishable.
		// Everything else — 5xx, DNS, TLS, timeout — is the product failing to
		// answer, and falls through to a wrapped error the handler renders as
		// 503. It must never arrive anywhere as a funnel.
		if status, ok := federation.StatusOf(err); ok {
			switch status {
			case http.StatusNotFound:
				return nil, fmt.Errorf("%w: %s", ErrNoFunnel, source)
			case http.StatusNotImplemented:
				return nil, fmt.Errorf("%w: %s", ErrNotImplemented, source)
			}
		}
		s.log.Error("onboardingfunnel: federated read failed", "source", source, "error", err)
		return nil, fmt.Errorf("reading %s onboarding funnel: %w", source, err)
	}

	// Only the envelope's own key is decoded, into a map of raw values: enough
	// to check the two invariants, not enough to constitute a model of the
	// funnel. Every value stays bytes.
	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("%w: decoding %s: %v", ErrUnreadable, source, err)
	}
	// Covers all three of: no `data` key, `"data":null`, and `"data":{}`. Each
	// would otherwise reach the console as a funnel with no stages in it,
	// which renders identically to a funnel where every stage is zero.
	if len(envelope.Data) == 0 {
		return nil, fmt.Errorf(
			"%w: %s returned no funnel object — an empty funnel is indistinguishable from zeroes",
			ErrUnreadable, source)
	}
	if _, ok := envelope.Data[medianKey]; !ok {
		return nil, fmt.Errorf(
			"%w: %s omitted %s — an absent median collapses \"not measurable\" into zero",
			ErrUnreadable, source, medianKey)
	}

	// Re-marshalling a map would reorder the keys and drop nothing else; the
	// original bytes are returned instead so what the console renders is
	// byte-for-byte what mark8ly said, ordering included.
	var raw struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("%w: decoding %s: %v", ErrUnreadable, source, err)
	}
	return raw.Data, nil
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
