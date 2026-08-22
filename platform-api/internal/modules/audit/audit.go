// Package audit is the platform API's estate audit-log module.
//
// # What this module is
//
// The estate-wide audit timeline — every product's rows in one shape, with the
// source stamped on each. It replaces apps/web's
// /api/admin/apps/{product}/audit-logs fan-out, which is being retired with
// that app.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package audit

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product declaring the audit contract, in display order.
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
	// federation source fails, so a nil logger is a panic on the one path that
	// only runs during an outage — the worst possible moment to discover it,
	// and one no test of the happy path reaches. Better a service that will
	// not start.
	if cfg.Log == nil {
		panic("audit: refusing to register with a nil Log — the federation failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
