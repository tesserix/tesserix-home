// Package tools is the platform API's internal-tools-directory module.
//
// # The module's public surface is this file, and nothing else
//
// Register and Config. Everything it does lives under internal/, which the
// compiler permits only code rooted here to import.
//
// # What this module is, in one line
//
// The directory of internal tools behind *.tesserix.app — Zitadel, Grafana,
// ArgoCD and a dozen more — which the console home page and command palette
// both render. It was a literal in packages/console-core/src/tools.ts until
// #318; the tables are seeded from that literal by migration 0031.
//
// # What it deliberately does NOT carry
//
// Status. Whether a tool is UP belongs to the health strip, and several of
// these expose no status endpoint at all — a status column here would be
// honest for some rows and a lie for the rest. The rule predates the move and
// survives it; see the head of tools.ts.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, audit, idempotency, write — and its own
// internals.
package tools

import (
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Pool is the shared tesserix-postgres pool. The module does not open its
	// own — no module does.
	Pool *pgxpool.Pool
	// Verifier authenticates both principal types. Never nil:
	// httpx.RegisterModule refuses to register a module without one.
	Verifier *auth.Verifier
	Log      *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	handler.New(service.New(cfg.Pool), cfg.Log).Routes(mux, cfg.Verifier)
}
