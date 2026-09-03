// Package conversions answers "has this lead email become a live account?"
// for one product.
//
// # What this module is, in one line
//
// The Handoff tab's missing half. `apps/console` has had the client, the
// suggestion UI and the `method: "matched"` write since #153/#279; what it has
// never had is anything to ask. This is that (#246).
//
// # Its route
//
//	GET /v1/conversions?source=<slug>&email=<address>
//
// # Why platform-api and not apps/web
//
// Ruling 27 (#153) sent every cross-product read through apps/web, "which
// holds the HMAC keys Kora and Fe3dr require — moving those keys into the
// console would be a secret-distribution change, not a refactor."
//
// That premise does not hold for mark8ly. apps/web holds Kora's, Homechef's
// and Otto's credentials and NO mark8ly credential: the `company` deployment
// carries MARK8LY_PLATFORM_API_URL and nothing to sign with. Honouring the
// ruling literally would mean distributing a new secret to a second workload —
// the exact cost the ruling exists to avoid — and into a surface being retired
// to a marketing page.
//
// platform-api already federates to the product that answers this, with the
// signed envelope its platformadmin middleware requires. So the road already
// exists and this module only has to use it.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package conversions

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/conversions/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/conversions/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product DECLARING conversions, not every federated
	// product. A product that has not declared it is refused before it is
	// called, so an operator sees "cannot be asked" rather than a 404 dressed
	// up as an outage.
	Slugs []string
	// Verifier authenticates. Never nil.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Log == nil {
		panic("conversions: refusing to register with a nil Log — the failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
