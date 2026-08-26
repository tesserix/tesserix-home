// Package tenants is the platform API's estate tenant directory module.
//
// # What this module is
//
// Every product's tenants in one shape, with the source stamped on each. It is
// the read half of what replaces apps/web's direct `UPDATE tenants` against
// mark8ly's database (tesserix-home#210) — a write that bypassed validation,
// domain events, cache invalidation and mark8ly's own audit row, because no
// API existed. One does now.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package tenants

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tenants/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tenants/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product that serves the `tenants` entity type, in display
	// order.
	//
	// NOT every federated product: §3.4's `{type}` is product-defined, so kora
	// serving `users` and `foods` does not mean it has tenants. Declaring the
	// list rather than deriving it keeps a product out of this surface until
	// someone says it belongs, which is the same absence-means-no rule the
	// federation registry itself uses.
	Slugs []string
	// Verifier authenticates. Never nil: httpx.RegisterModule refuses without one.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	// Refused at wiring time for the reason the audit module states: the
	// service writes to cfg.Log when a federated source fails, so a nil logger
	// panics on the one path that only runs during an outage — the worst
	// moment to discover it, and one no happy-path test reaches.
	if cfg.Log == nil {
		panic("tenants: refusing to register with a nil Log — the federation failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
