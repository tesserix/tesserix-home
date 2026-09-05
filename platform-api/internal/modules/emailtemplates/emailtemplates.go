// Package emailtemplates serves the transactional email template registries a
// product owns, to the console (tesserix-home#588, epic #586).
//
// # What this replaces
//
// apps/web's editor, which reached mark8ly's `email_templates` table by
// CONNECTING TO ANOTHER PRODUCT'S DATABASE and then pinging an internal HTTP
// endpoint to evict the send path's cache. The console has no such credential
// and should not acquire one: it reaches every product the same way, through
// this service and the HMAC-signed federation contract. The rows stay where
// they are — mark8ly owns them — and only the transport changes.
//
// # What it is not
//
// NOT an authoring surface for keys. A key exists because a Go call site in
// the product renders it, so a console-created key would look exactly like
// copy that sends and send nothing. Creation, deletion, per-tenant overrides,
// locales and version history are all out of scope; none of them exist in the
// product's schema either.
//
// NOT the whole of mark8ly's registry, and the console must say so. mark8ly
// keeps templates in two services with mirrored tables and federation reaches
// one of them, so the auth mails — `welcome`, `password_reset`, `invitation`,
// `login_otp`, `email_verification`, `new_device_login` — are not here until
// mark8ly#720 federates that service. A list that silently omits
// `password_reset` is worse than no list.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package emailtemplates

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product DECLARING this endpoint, not every product.
	//
	// The declaration is the mechanism: a product that keeps no transactional
	// templates answers 404, which an operator would read as a failed source
	// where the honest answer is that the product has no registry. Absence
	// means no — a source joins this surface when someone declares it in
	// FEDERATION_<SLUG>_ENDPOINTS, not when someone forgets to exclude it.
	//
	// Empty is a legitimate state and answers 501, never an empty 200.
	Slugs []string
	// Verifier authenticates. Never nil: httpx.RegisterModule refuses without one.
	Verifier *auth.Verifier
	// Log is required: Register panics without one. See the guard below.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	// Refused at wiring time, as the inbox and audit modules do, and for the
	// same reason: the service writes to cfg.Log when a federated source
	// fails, so a nil logger panics on the one path that only runs during an
	// outage — the worst moment to discover it, and one no happy-path test
	// reaches.
	if cfg.Log == nil {
		panic("emailtemplates: refusing to register with a nil Log — the federation failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Slugs, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
