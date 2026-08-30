// Package sources is the platform API's answer to "which products declare
// what".
//
// # What this module is
//
//	GET /v1/platform/sources
//
// returns this deployment's federation declarations, inverted:
//
//	{"endpoints": {"onboarding": ["mark8ly"]},
//	 "entities":  {"tenants": ["mark8ly"], "users": ["kora"]}}
//
// # Why it exists
//
// Several surfaces in this service are scoped to the products DECLARING an
// endpoint rather than to every federated product — the onboarding funnel and
// the outbox read Registry.SlugsImplementing, entities and tenants read
// SlugsServing. Each of those routes then requires a `source`, and answers 400
// for a product that did not declare. Until this route, nothing exposed the
// list a caller would need to avoid that 400, so the console hardcoded
// FUNNEL_SOURCE = "mark8ly" and a source picker was not buildable: it would
// have offered sources the API refuses.
//
// # Why one general route and not a per-module one
//
// The immediate need was one endpoint's declarers. Adding
// /v1/onboarding/sources for it would have made the next such need add
// /v1/outbox/sources, and so on — N routes answering one question, each in its
// own module's vocabulary, and each having to decide separately what an
// unrecognised name means.
//
// The question is not endpoint-specific and neither is its answer: the
// registry holds every declaration at once, and inverting it costs the same
// for all of them. So the module is general, lives on the platform rail beside
// /v1/platform/health, and covers §3.4's entity TYPES with the same mechanism
// rather than leaving a second version of this decision for later.
//
// # What a slug here does and does not promise
//
// It promises a DECLARATION, not a working product. A slug appears because
// FEDERATION_<SLUG>_ENDPOINTS named the endpoint; whether the product answers
// is a different question this route deliberately does not ask, because
// answering it would mean fanning out to every product on a route the console
// renders before it has a question to ask. A source that turns out to be
// unreachable surfaces where it belongs — on the read that needed it, where
// "unreachable" is already kept distinct from "empty".
//
// The over-declaration registry.go warns about is therefore visible here as an
// entry, and only visible as a failure once someone reads that source. That is
// the same trade the funnel makes and it is the safe direction: an
// under-declared product is a missing picker entry, an over-declared one is
// one failing read.
//
// # It imports no other module
//
// Only the kernel — httpx, auth — and its own internals. It does not even take
// a federation.Client: it calls no product. See the service's package doc.
package sources

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/sources/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/sources/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Config is what the module needs from the composition root.
//
// Both maps are slug → what that product declared, and both are OPTIONAL: a
// deployment that federates nothing is a legitimate configuration and renders
// as two empty objects, not as an error.
//
// They are plain maps rather than []federation.Product on purpose. Product
// carries the HMAC Secret, and this module's whole job is to marshal what it
// is given into a response — taking a type that cannot hold a secret is what
// makes leaking one impossible here rather than merely unlikely. It is the
// same reason the entities module takes a map instead of the registry.
type Config struct {
	// Endpoints is each product's FEDERATION_<SLUG>_ENDPOINTS.
	Endpoints map[string][]string
	// Entities is each product's FEDERATION_<SLUG>_ENTITIES.
	Entities map[string][]string
	// Verifier authenticates. Never nil.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Log == nil {
		panic("sources: refusing to register with a nil Log — the refusal path writes to it")
	}
	handler.New(service.New(cfg.Endpoints, cfg.Entities), cfg.Log).Routes(mux, cfg.Verifier)
}
