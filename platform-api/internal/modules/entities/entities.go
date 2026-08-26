// Package entities is the platform API's §3.4 entity-read module.
//
// # What this module is
//
// One product's records of one product-defined type — `users`, `foods` — for
// the Directory and the command palette. It does NOT fan out: an entity type
// is not universal, and merging two products' `users` makes a table whose
// columns mean different things per row (§8.5).
//
// # Why it is not the tenants module
//
// `tenants` is also a §3.4 type, and the tenants module reads it — but that
// module is the estate tenant DIRECTORY: it fans out, merges and reports
// partial failure, because a tenant means the same thing everywhere. This one
// is the general per-product read. Two surfaces, two shapes, one contract
// endpoint underneath.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package entities

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/entities/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/entities/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Types maps each product slug to the §3.4 types it declared. A product
	// absent from this map is unknown; one present with an empty list serves
	// no type. Both are refused, with different messages.
	Types map[string][]string
	// Verifier authenticates. Never nil.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Log == nil {
		panic("entities: refusing to register with a nil Log — the failure path writes to it")
	}
	handler.New(service.New(cfg.Fed, cfg.Types, cfg.Log), cfg.Log).Routes(mux, cfg.Verifier)
}
