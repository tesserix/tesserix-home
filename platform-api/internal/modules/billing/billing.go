// Package billing is the platform API's estate billing module.
//
// # What this module is
//
// §8.2's two reads — recurring plans and expiring trials — federated across
// every product that implements them. §8.2's own reason for existing:
//
//	Five endpoints were enough to make a product manageable. They are not
//	enough to make it legible as a business.
//
// # Why it fans out when kpis does not
//
// §8.5's test: can two products' rows sit in one table without a column
// meaning something different in each? A plan, a status, an amount in minor
// units and a period end mean the same thing whoever issued them — so yes, and
// this is estate-shaped. A KPI map is not: two products' `orders_today`
// describe different businesses.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package billing

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product declaring §8.2.
	//
	// Declared rather than assumed, like the inbox: §8.2 says a product with
	// no billing concept implements NONE of these endpoints, so asking one
	// that does not answers 404 and renders to an operator as a failed source
	// — on a revenue surface, where a red entry reads as lost money rather
	// than as a product that never sold anything.
	Slugs []string
	// Verifier authenticates. Never nil.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Log == nil {
		panic("billing: refusing to register with a nil Log — the federation failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
