// Package kpis is the platform API's product headline-metrics module.
//
// # What this module is
//
// One product's §3.1 metrics map, read on demand. It does NOT fan out: two
// products' headline numbers describe different businesses, and merging them
// produces a figure about nothing (§8.5).
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package kpis

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/kpis/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/kpis/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every federated product. NOT filtered by a declaration: §3.1 is
	// universal — every product implements /admin/kpis, and one with no
	// metrics says so with a 501 rather than by not mounting the route. That
	// is exactly the distinction this module preserves, so filtering here
	// would discard the answer it exists to carry.
	Slugs []string
	// Verifier authenticates. Never nil.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Log == nil {
		panic("kpis: refusing to register with a nil Log — the failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
