// Package repos is the platform API's GitHub repositories module.
//
// # What this module is
//
// Every repository in the `tesserix` organisation, with the security signals
// GitHub will give us for it — Dependabot alerts, secret-scanning alerts,
// branch protection — and the two bulk changes an operator makes to them:
// visibility and archiving.
//
// It authenticates as its own GitHub App, installed org-wide. Deliberately NOT
// secrets-api's App, which is installed on tesserix-k8s alone: widening that
// App to administer every repository would give the service that holds the
// estate's secrets the power to publish its source as well.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, audit — and its own internals.
package repos

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/repos/internal/github"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/repos/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/repos/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// GitHub is the App this module authenticates as. Re-exported so cmd/server
// can fill it from config without reaching into the module's internals.
type GitHub = github.Config

// Config is what the module needs from the composition root.
type Config struct {
	// GitHub is the App. Unconfigured (every field empty) is legal and makes
	// every route answer 501; half-configured panics at wiring time.
	GitHub GitHub
	// HTTPClient reaches GitHub. Nil means a default with a timeout; tests
	// pass an httptest server's.
	HTTPClient *http.Client
	// Pool is where a write's audit row is recorded.
	Pool *pgxpool.Pool
	// Verifier authenticates. Never nil: httpx.RegisterModule refuses without one.
	Verifier *auth.Verifier
	// Log is required: Register panics without one.
	Log *slog.Logger
}

// Module is the built module: its routes, and the sweeper that closes public
// windows. Built once so both share one GitHub client and its token cache.
type Module struct {
	cfg Config
	svc *service.Service
}

// New builds the module. It panics on a nil Log or a half-configured App, for
// the reasons below.
func New(cfg Config) *Module {
	if cfg.Log == nil {
		panic("repos: refusing to register with a nil Log — every GitHub failure path writes to it")
	}
	var gh *github.Client
	if cfg.GitHub.Enabled() {
		client, err := github.New(cfg.GitHub, cfg.HTTPClient)
		if err != nil {
			// A typo'd or truncated key must fail the rollout, not answer
			// 501 and look like a surface nobody switched on.
			panic("repos: the GitHub App is half-configured: " + err.Error())
		}
		gh = client
	}
	var db service.Beginner
	if cfg.Pool != nil {
		db = cfg.Pool
	}
	return &Module{cfg: cfg, svc: service.New(gh, db, cfg.Log)}
}

// Register mounts the module's routes.
func (m *Module) Register(mux *http.ServeMux) {
	handler.New(m.svc, m.cfg.Log).Routes(mux, m.cfg.Verifier)
}

// Register builds the module and mounts its routes, for callers that do not
// run the sweeper.
func Register(mux *http.ServeMux, cfg Config) { New(cfg).Register(mux) }

// SweepInterval is how often closed public windows are looked for. A window
// therefore closes up to this late, which the console says.
const SweepInterval = time.Minute

// ExpireDue closes every public window that has passed. Exported for the
// sweeper loop and for tests, which pass their own clock.
func (m *Module) ExpireDue(ctx context.Context, now time.Time) (int, error) {
	return m.svc.ExpireDue(ctx, now)
}

// RunSweeper closes public windows until ctx ends. Every replica runs it; the
// row locks in ExpireDue keep them from closing one window twice.
func (m *Module) RunSweeper(ctx context.Context) {
	ticker := time.NewTicker(SweepInterval)
	defer ticker.Stop()
	for {
		if n, err := m.ExpireDue(ctx, time.Now()); err != nil {
			m.cfg.Log.ErrorContext(ctx, "repos: sweeping public windows", "error", err)
		} else if n > 0 {
			m.cfg.Log.InfoContext(ctx, "repos: public windows closed", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// RunSignalRefresh keeps the security signals warm until ctx ends, starting
// with a read at boot, so the repositories page never waits on GitHub's alert
// pagination. Every replica runs it, for its own cache.
func (m *Module) RunSignalRefresh(ctx context.Context) {
	ticker := time.NewTicker(service.SignalsRefresh)
	defer ticker.Stop()
	for {
		m.svc.RefreshSignals(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
