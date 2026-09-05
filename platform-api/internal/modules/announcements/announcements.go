// Package announcements serves the platform broadcasts a product shows its
// merchants.
//
// # What this replaces
//
// apps/web's `GET /api/internal/platform-announcements`, the last of the
// internal endpoints a product still calls with the shared bearer token
// (tesserix-home#152). The rows, the table and the JSONB targeting are
// unchanged — this is the same query behind a different door.
//
// # What it is not
//
// NOT the authoring surface. Operators still create and expire announcements
// through apps/web's admin, and tesserix-home#150 will build a better one with
// scheduling and audience preview. This module is the read a PRODUCT makes,
// and it deliberately serves no operator: the two want different shapes, and
// #150's acceptance says the internal channel contract does not change there.
package announcements

import (
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/productscope"
)

// Config is what the module needs from the composition root.
type Config struct {
	Pool     *pgxpool.Pool
	Verifier *auth.Verifier
	Log      *slog.Logger
	// Scope maps an attested subject to the product it speaks for. A nil
	// registry resolves nobody, which refuses every caller rather than serving
	// one an unscoped answer.
	Scope *productscope.Registry
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	handler.New(service.New(cfg.Pool), cfg.Log, cfg.Scope).Routes(mux, cfg.Verifier)
}
