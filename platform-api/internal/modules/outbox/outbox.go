// Package outbox is the platform API's estate outbox module.
//
// # What this module is
//
// The estate-wide outbox — every product's stuck-or-failed outbox_events rows
// in one shape, with the source stamped on each. It federates the Product
// Admin Integration Contract's `outbox` endpoint, mark8ly's implementation of
// which is pinned at
// services/marketplace-api/internal/handlers/platformadmin/outbox.go, and
// answers the same question that endpoint's own doc comment states: "what is
// stuck, what failed, and why" (#331).
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package outbox

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/outbox/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/outbox/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product declaring the contract's outbox endpoint. Pass
	// federation.Registry.SlugsImplementing("outbox"), NOT Slugs(): an
	// outbox is not universal, and a product without one would answer 404,
	// surfacing to an operator as a failed source when the honest answer is
	// that the product has none.
	Slugs []string
	// Verifier authenticates. Never nil: httpx.RegisterModule refuses without one.
	Verifier *auth.Verifier
	// Log is required: Register panics without one. See the guard below.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	// Refused at wiring time, the way httpx.RegisterModule refuses a nil
	// verifier, and for the same reason: the service calls cfg.Log when a
	// federation source fails, so a nil logger is a panic on the one path
	// that only runs during an outage — the worst possible moment to
	// discover it, and one no test of the happy path reaches. Better a
	// service that will not start.
	if cfg.Log == nil {
		panic("outbox: refusing to register with a nil Log — the federation failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
