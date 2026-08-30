// Package onboardingfunnel is the platform API's federated read of a
// product's onboarding funnel.
//
// # What this module is
//
//	GET /v1/onboarding/funnel?source=<slug>
//
// proxies the product's own GET /admin/onboarding/funnel — mark8ly's, today —
// forwarding the window (created_from, created_to) and returning the funnel
// object unmodified.
//
// # Why the payload is forwarded, not modelled
//
// tesserix-home#404's first rule: the product's own stage vocabulary is
// rendered verbatim, because a console-side enumeration of funnel stages is a
// second vocabulary that drifts from the first. A struct in this module would
// BE that second vocabulary. See package service's doc for what it does check
// instead, and why those two checks are not a model.
//
// # Why a failed read can never look like an empty funnel
//
// #404's second rule: "a stage with zero is a measurement; a funnel that could
// not be read is not". Every failure path in this module ends in a status
// code, never a 200 carrying an empty or zeroed funnel, and
// `median_completion_seconds` stays nullable end to end — null means "no
// session completed in the window, so there is no median", which is a
// different fact from zero. Both halves are pinned by tests that fail if the
// two states ever collapse.
//
// # This is a product's own endpoint, like koraaimetrics
//
// /admin/onboarding/funnel is not a §3 contract endpoint: it is mark8ly's
// route, and the shape of an onboarding funnel is not something the contract
// has ever specified. So the module reads Registry.SlugsImplementing
// ("onboarding") rather than every federated product — the same absence-means-
// no rule Entities and Endpoints use. A product stays out of this surface
// until someone declares FEDERATION_<SLUG>_ENDPOINTS to include `onboarding`,
// rather than until someone remembers to exclude it. That direction is the
// safe one: an under-declared product is a visibly missing source, an
// over-declared one is a permanent red failure on a surface operators are
// meant to trust.
//
// Unlike koraaimetrics, though, the route is NOT named after its product.
// #404 §2's rule decides it: a surface belongs on the platform rail when the
// operator's question spans products, and "where do signups stall" is a
// question every product with onboarding has. mark8ly is the first
// implementer, not the only conceivable one — so `/v1/onboarding/funnel?
// source=mark8ly` reads as "the estate's onboarding surface, asked about
// mark8ly", which is what it is. Food-resolution accuracy, by contrast, has no
// estate-generic equivalent at all, which is why that module carries Kora's
// name and this one does not.
//
// # It federates the funnel and not the sessions
//
// mark8ly also serves GET /admin/onboarding/sessions — a paginated list of
// individual sessions with filters for status, abandonment, idle hours and
// tenant. It is deliberately not federated here, for three reasons:
//
//   - The surface #404 asks for needs the counts. The sessions list is a
//     different read for a different question ("which merchant do I call"),
//     and it belongs with the CSM fast-path queue on mark8ly's PRODUCT rail —
//     which #404 puts explicitly out of scope.
//   - Its rows carry merchant email addresses. Federating PII deserves its own
//     decision with its own reviewer, not a free ride on a counts endpoint.
//   - Its eight query parameters and pagination make it a listing, and this
//     service's listing conventions (httpx.Meta, §4.1's pagination block) are
//     a design conversation, not a copy of this file.
//
// The door is left open, and the work is small when it is wanted: the
// declaration mechanism already exists, and the module layout here takes a
// second route without restructuring. It is a separate decision, not a
// missing piece of this one.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package onboardingfunnel

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/onboardingfunnel/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/onboardingfunnel/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product DECLARING an onboarding funnel, not every
	// federated product. Unlike §3.1's KPIs, /admin/onboarding/funnel is not
	// universal and a product without one does not answer 501 — it simply does
	// not mount the route, so asking would 404 and show as a failed source
	// where the honest answer is that the product has no funnel.
	Slugs []string
	// Verifier authenticates. Never nil.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Log == nil {
		panic("onboardingfunnel: refusing to register with a nil Log — the failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
