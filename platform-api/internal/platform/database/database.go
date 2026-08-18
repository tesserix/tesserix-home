// Package database owns the connection to tesserix-postgres. Kernel, not a
// module: every module that needs data takes a *Pool, and no module opens its
// own.
//
// # No ORM
//
// The estate's older services use GORM. This one uses pgx directly, for a
// reason specific to the work ahead rather than a preference: the data layer
// this service is absorbing (ADR-003 D7) is hand-written SQL in
// apps/console/lib/db/*, including keyset pagination (#240, #241) and a
// contact clock that must advance in the same transaction as an activity
// insert (#245). Porting hand-written SQL through an ORM's query builder
// converts a mechanical translation into a re-derivation, and the tests that
// currently prove those queries correct are pglite integration tests against
// the SQL itself.
//
// This is an internal choice with no bearing on the API surface, so it does not
// contradict #269's "look like the other ~30 services" — that argument is about
// the contract, which httpx keeps.
package database

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/config"
)

// Pool is the service's connection pool.
type Pool struct {
	*pgxpool.Pool
}

// Open connects and verifies the connection before returning.
//
// The ping is not ceremony. A pool that constructs successfully has not
// necessarily reached the database — pgxpool connects lazily — so without it a
// misconfigured service would start healthy and fail on its first real request,
// which is exactly the failure mode config.Load is written to avoid.
func Open(ctx context.Context, cfg config.Database) (*Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.DSN())
	if err != nil {
		// The DSN carries the password. Never include it in an error.
		return nil, fmt.Errorf("parsing database configuration: %w", redact(err, cfg))
	}

	poolCfg.MaxConns = cfg.MaxConns
	poolCfg.MinConns = cfg.MinConns
	// A connection that has been idle this long is returned to the server. On a
	// shared instance, holding one open costs someone else.
	poolCfg.MaxConnIdleTime = 5 * time.Minute
	poolCfg.MaxConnLifetime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("creating connection pool: %w", redact(err, cfg))
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connecting to %s: %w", cfg.String(), redact(err, cfg))
	}

	return &Pool{Pool: pool}, nil
}

// Health reports whether the database is reachable right now.
//
// Used by the readiness probe, and deliberately given its own short timeout: a
// readiness check that blocks on an unreachable database until the request
// times out is a readiness check that reports nothing in the one situation it
// exists for.
func (p *Pool) Health(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return p.Ping(ctx)
}

// redact strips the password from an error's text.
//
// pgx errors sometimes echo the connection string. A credential reaching a log
// line through an error message is the same leak as printing it directly, and
// harder to notice.
func redact(err error, cfg config.Database) error {
	if err == nil || cfg.Password == "" {
		return err
	}
	msg := err.Error()
	cleaned := strings.ReplaceAll(msg, cfg.Password, "[REDACTED]")
	if cleaned == msg {
		return err
	}
	return errors.New(cleaned)
}
