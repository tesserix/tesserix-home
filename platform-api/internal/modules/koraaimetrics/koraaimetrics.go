// Package koraaimetrics is platform-api's one named federated route for
// Kora's food-resolution accuracy metrics.
//
// # What this module is
//
//	GET /v1/kora/ai-metrics
//
// proxies Kora's own GET /admin/ai-metrics (tesserix/kora#507), forwarding
// the window (from, to) and paging (page, limit) query parameters and
// returning Kora's response body unmodified.
//
// # Why this is a named route and not a generic passthrough
//
// tesserix-home#403 weighed two shapes: this one, or a generic
// GET /v1/products/{slug}/{endpoint} passthrough. The generic shape was
// rejected — with one caller (this endpoint) there is no evidence about what
// a generic shape should be, and an opaque passthrough removes this layer's
// ability to validate anything at all, which is a far larger security
// surface than one more known, reviewable route. §8.8/§8.9's argument
// applies directly: an endpoint designed against no real consumer is
// designed wrong.
//
// Food-resolution accuracy itself has no estate-generic equivalent — no
// other product resolves a spoken phrase to a food item — so Kora's side
// was, correctly, scoped as Kora's own endpoint rather than a §3 contract
// amendment. This module is the platform-side consequence of that choice: a
// product's name in platform-api's route table, on purpose, because the
// alternative was worse.
//
// # The trigger to revisit this decision
//
// A second product wanting the same treatment — not before. At that point
// the DECLARATION half of a generic mechanism already exists:
// FEDERATION_KORA_ENDPOINTS and Registry.SlugsImplementing already let a
// product declare which contract endpoints beyond the required five it
// implements (today only `inbox`). So the revisit is smaller than it looks —
// only the ROUTING half (turning a declared `{endpoint}` into a call,
// generically and safely) would be new work, not the whole mechanism.
// Recording that here keeps the trigger cheap to evaluate rather than
// re-derived from scratch.
//
// # It does not model Kora's response
//
// §8.9's cautionary tale is exactly the failure mode this module exists to
// avoid: an entity row modelled as a fixed struct read off Kora's foods
// response silently dropped `sublabel`, and nobody noticed until a users
// directory rendered two people identically. See package service's doc for
// how this module forwards Kora's bytes instead of decoding them.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package koraaimetrics

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/koraaimetrics/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/koraaimetrics/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls Kora. Never nil.
	Fed *federation.Client
	// Verifier authenticates. Never nil.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Log == nil {
		panic("koraaimetrics: refusing to register with a nil Log — the failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
