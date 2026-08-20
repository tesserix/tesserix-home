// Package crm is the platform API's CRM queues module.
//
// # The module's public surface is this file, and nothing else
//
// Register and Config. The query grammar, the SQL, the domain rules and the
// wire shapes all live under internal/, which the compiler permits only code
// rooted here to import — so a future modules/billing cannot reach a query, a
// filter axis or a handler even by accident. internal/modules/doc.go explains
// why both that and the import-graph check exist, and why the enforcement had
// to land with the FIRST module rather than the third.
//
// # What this module is, in one line
//
// The two work queues the platform team runs its sales follow-up from — what
// is DUE and what is DRIFTING — plus the one write that answers them
// (scheduling the next action). `crm_organisations`, `crm_contacts` and
// `crm_opportunities` already exist in tesserix-postgres; this is a Go rewrite
// of the queries apps/console serves today, against a contract designed rather
// than ported (#269).
//
// # Its routes
//
//	GET /v1/crm/queues/due                        what is scheduled and past due
//	GET /v1/crm/queues/drifting                   what has gone quiet with nothing scheduled
//	PUT /v1/crm/opportunities/{id}/next-action    schedule or clear the next action
//
// Both queues answer with the same resource — the OPPORTUNITY, and nothing
// else. That decision, and the two fields that look like exceptions to it, are
// argued where they are implemented, in internal/service/wire.go. The query
// grammar is argued in internal/handler/handler.go.
//
// Every route gates on the `crm` capability, the write included: the CRM has
// no write verb in the vocabulary to stack on top of the surface, and
// inventing one here would be a second vocabulary. internal/handler's Routes
// carries that finding in full.
//
// # It imports no other module
//
// It depends only on the kernel — httpx, auth, paging, audit, idempotency,
// write — and on its own internals. If it ever needs another module's data,
// the interface is declared here and satisfied in cmd/server, so the provider
// does not know this module exists.
package crm

import (
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
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
}

// Register mounts the module's routes.
//
// Called through httpx.RegisterModule in cmd/server, which is what enforces
// the verifier. Calling this directly would bypass that check, which is why
// the module's own tests go through RegisterModule too.
func Register(mux *http.ServeMux, cfg Config) {
	handler.New(service.New(cfg.Pool), cfg.Log).Routes(mux, cfg.Verifier)
}
