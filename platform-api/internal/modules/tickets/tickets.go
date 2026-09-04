// Package tickets is the platform API's tickets module.
//
// # The module's public surface is this file, and nothing else
//
// Register and Config. Everything the module actually does lives under
// internal/, which the compiler permits only code rooted here to import — so a
// future modules/billing cannot reach a query, a domain type or a handler even
// by accident. internal/modules/doc.go explains why both that and the
// import-graph check exist, and why the enforcement had to land with the FIRST
// module rather than the third.
//
// # What this module is, in one line
//
// The cross-product support queue that merchants file against the Tesserix
// platform team. `platform_tickets` and `platform_ticket_replies` already
// exist in tesserix-postgres; this is a Go rewrite of the queries apps/web
// serves today, against a contract designed rather than ported (#269).
//
// # Its routes
//
//	GET    /v1/tickets              the queue, filtered and keyset-paged
//	GET    /v1/tickets/summary      the standing count, unfiltered
//	GET    /v1/tickets/{id}         one ticket and its thread
//	POST   /v1/tickets/{id}/replies a reply, optionally transitioning the ticket
//	PATCH  /v1/tickets/{id}         a transition on its own
//
// The listing and the summary are separate resources, which is the central
// decision of #269 and is argued where it is implemented, in
// internal/service/wire.go.
//
// # It imports no other module
//
// It depends only on the kernel — httpx, auth, paging, audit, idempotency —
// and on its own internals. If it ever needs another module's data, the
// interface is declared here and satisfied in cmd/server, so the provider does
// not know this module exists.
package tickets

import (
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/productscope"
)

// Config is what the module needs from the composition root.
//
// A struct rather than positional arguments so a module gaining a dependency
// is an additive change in one file rather than a signature break in cmd.
type Config struct {
	// Pool is the shared tesserix-postgres pool. The module does not open its
	// own — no module does; see the kernel's database package.
	Pool *pgxpool.Pool
	// Verifier authenticates both principal types (ADR-003 D8). Never nil:
	// httpx.RegisterModule refuses to register a module without one, which is
	// what stops "authentication disabled" from outliving its purpose.
	Verifier *auth.Verifier
	Log      *slog.Logger
	// Scope maps an attested subject to the product it speaks for (#152).
	//
	// A nil registry resolves nobody, which REFUSES every machine caller
	// rather than admitting one unscoped — so a deployment that forgets to
	// wire this loses the product path entirely and keeps the operator path
	// working, which is the safe direction to fail.
	Scope *productscope.Registry
}

// Register mounts the module's routes.
//
// Called through httpx.RegisterModule in cmd/server, which is what enforces
// the verifier. Calling this directly would bypass that check, which is why
// the module's own tests go through RegisterModule too.
func Register(mux *http.ServeMux, cfg Config) {
	handler.New(service.New(cfg.Pool), cfg.Log, cfg.Scope).Routes(mux, cfg.Verifier)
}
