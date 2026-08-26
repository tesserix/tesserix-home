// Package inbox is the platform API's estate inbox module.
//
// # What this module is
//
// Everything waiting on a human, across every federating product, in one
// queue. Contract §3.2 calls it "the load-bearing one", and the reason is
// §8.5: implementing an inbox does not earn a product a rail entry, it makes
// that product a source in a surface that already exists. This is that
// surface.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package inbox

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/inbox/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/inbox/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product declaring §3.2, in display order.
	Slugs []string
	// Verifier authenticates. Never nil: httpx.RegisterModule refuses without one.
	Verifier *auth.Verifier
	// Log is required: Register panics without one. See the guard below.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	// Refused at wiring time, as the audit module does, and for the same
	// reason: the service writes to cfg.Log when a federation source fails, so
	// a nil logger panics on the one path that only runs during an outage —
	// the worst moment to discover it, and one no happy-path test reaches.
	if cfg.Log == nil {
		panic("inbox: refusing to register with a nil Log — the federation failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
