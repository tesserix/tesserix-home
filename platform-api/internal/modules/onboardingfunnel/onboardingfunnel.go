// Package onboardingfunnel is the platform API's federated read of a
// product's onboarding funnel and of the sessions behind it.
//
// # What this module is
//
//	GET /v1/onboarding/funnel?source=<slug>
//	GET /v1/onboarding/sessions?source=<slug>
//
// proxy the product's own GET /admin/onboarding/funnel and
// GET /admin/onboarding/sessions — mark8ly's, today — forwarding the filters
// and returning the funnel object and the session rows unmodified.
//
// # Why the payload is forwarded, not modelled
//
// tesserix-home#404's first rule: the product's own stage vocabulary is
// rendered verbatim, because a console-side enumeration of funnel stages is a
// second vocabulary that drifts from the first. A struct in this module would
// BE that second vocabulary. See package service's doc for what it does check
// instead, and why those two checks are not a model.
//
// # Why a failed read can never look like an empty funnel, or an empty queue
//
// #404's second rule: "a stage with zero is a measurement; a funnel that could
// not be read is not". Every failure path in this module ends in a status
// code, never a 200 carrying an empty or zeroed funnel, and
// `median_completion_seconds` stays nullable end to end — null means "no
// session completed in the window, so there is no median", which is a
// different fact from zero. Both halves are pinned by tests that fail if the
// two states ever collapse.
//
// # These are a product's own endpoints, like koraaimetrics
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
// # It federates the sessions too, and that was a decision, not a default
//
// READ THIS BEFORE "TIDYING" THE SESSIONS ROUTE AWAY.
//
// When the funnel landed, mark8ly's GET /admin/onboarding/sessions was
// deliberately left unfederated, and this doc said so. One of the three
// reasons given was the load-bearing one: the rows carry merchant email
// addresses, and "federating PII deserves its own decision with its own
// reviewer, not a free ride on a counts endpoint".
//
// That decision has since been made and APPROVED by the repo owner, and
// GET /v1/onboarding/sessions is the result. It is recorded here rather than
// only in a commit message because the shape of the code no longer shows it:
// a second route in a module whose doc once explained why there was only one
// looks like drift, and the honest record is the opposite — it is here
// BECAUSE someone weighed the PII and said yes, not because nobody noticed
// the earlier paragraph.
//
// The other two reasons the funnel gave have also been answered rather than
// waived:
//
//   - "It belongs on mark8ly's PRODUCT rail with the CSM queue." The CSM
//     fast-path queue still does. This route is the estate-side read of the
//     same data for the operator already looking at the funnel — "57 sessions
//     were abandoned" and "which 57" are one question asked twice, and an
//     operator who can see the first and not the second has to leave the
//     console to act on what it just told them.
//   - "Its query parameters and pagination make it a listing, and this
//     service's listing conventions are a design conversation." That
//     conversation is settled in the handler: the rows go through
//     httpx.WriteMeta, mark8ly's page/limit/total becomes Meta.Total and
//     Meta.Limit, and its offset `page` has no home in this service's
//     cursor-shaped Meta and is not invented one.
//
// Two corrections to what that paragraph claimed, both found by reading
// mark8ly's handler on 2026-08-30 (marketplace-api a26ec7d2) rather than by
// trusting this file. The route takes SIX parameters, not eight: status,
// created_from, created_to, abandoned, page, limit. And it has no filter for
// idle hours or tenant — `idle_hours` is a field on the row, not a query
// parameter, and its client's `order` parameter is not read by the admin
// handler at all.
//
// # What the PII decision obliges, concretely
//
// Approval to federate the rows is not approval to spread them. The rules the
// code enforces, each with a test that fails if it stops being true:
//
//   - An email address may reach exactly one place: the response body, on the
//     success path. Never a log line, never an error message, never a URL.
//   - No failure path may quote the product's response. This is why
//     service.ListSessions reports the JSON KIND that arrived and never the
//     value, and why every unreadable outcome goes through one logging helper
//     that is handed a message rather than a body.
//   - The page size is clamped here, at 200, because a page size is a PII
//     blast radius — see maxSessionLimit for the three constraints that pick
//     the number.
//
// # The rows are forwarded verbatim, for a reason that already bit
//
// Same rule as the funnel, and the sessions route is where it earns its keep
// most visibly. mark8ly's internal onboardingfunnel.Session carries
// `email_verified_at`; its wire row deliberately does NOT project it, and
// projects `draft` — a JSONB blob of merchant-entered wizard data — nowhere at
// all. A Go struct written from the internal type would have invented a field
// that never arrives; one written from the wire would drop the next field
// mark8ly adds. Forwarding the bytes is the only version that is wrong in
// neither direction.
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
	// federated product. It scopes BOTH routes: mark8ly mounts the funnel and
	// the session list from one handler behind one dependency, so there is no
	// state in which a product declares `onboarding` and serves only one.
	//
	// Unlike §3.1's KPIs, these routes are not universal, and a product
	// without them does not answer 501 — it simply does not mount them, so
	// asking would 404 and show as a failed source where the honest answer is
	// that the product has no onboarding funnel.
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
