// Command server is the platform API.
//
// It composes the kernel and the domain modules and serves them as one
// process — the modular monolith ADR-003 D2 chose. Today it composes no
// modules: this is the scaffold from #277, and its job is to prove the delivery
// path end to end while the only thing at risk is a health check.
//
// This file is also the one place allowed to import every module. Composition
// happens here, which is why the boundary rule in internal/architecture applies
// to modules/ and not to cmd/.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/config"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/database"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/reqid"
)

func main() {
	// Wrapped in reqid.LogHandler so every line logged with a request's context
	// carries its id.
	//
	// Not decoration. Two log lines in this service exist precisely because the
	// client is told deliberately less than the log knows — auth's "token
	// rejected", which answers one 401 for four different failures, and the
	// modules' "request failed", which hides a driver error behind a generic
	// 500. The request id is the only thing joining what the caller saw to what
	// actually happened, and without this wrapper it reached neither line.
	log := slog.New(reqid.LogHandler(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))
	slog.SetDefault(log)

	if err := run(log); err != nil {
		log.Error("startup failed", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := database.Open(ctx, cfg.Database)
	if err != nil {
		return err
	}
	defer pool.Close()

	log.Info("connected",
		slog.String("database", cfg.Database.String()),
		slog.String("env", cfg.Env),
	)

	// Discovery happens here, at startup, so an unreachable Zitadel refuses to
	// boot rather than failing every request. A service that starts unable to
	// verify tokens can only fail closed, which is a harder outage to read.
	verifier, err := auth.NewVerifierFromConfig(ctx, auth.Config{
		Enabled:   cfg.Auth.Enabled,
		Issuer:    cfg.Auth.Issuer,
		ProjectID: cfg.Auth.ProjectID,
	})
	if err != nil {
		return err
	}

	if verifier == nil {
		// Loud on purpose. This is legitimate only while the service composes
		// no modules; the router refuses to register one without a verifier, so
		// the state cannot outlive its justification silently.
		log.Warn("authentication is DISABLED — legitimate only while no module is served",
			slog.String("enable_with", "PLATFORM_API_AUTH_ENABLED=true"),
		)
	} else {
		log.Info("authentication enabled",
			slog.String("issuer", cfg.Auth.Issuer),
			slog.String("audience", cfg.Auth.ProjectID),
		)
	}

	mux := httpx.Router(pool, verifier, log)

	// Modules register here, on the bare mux. This is the one file allowed to
	// import every module — internal/modules/doc.go explains why the boundary
	// rule applies to modules/ and not to cmd/.
	//
	// Through RegisterModule rather than by calling a module's Register
	// directly: that is what refuses to serve a domain module without a
	// verifier, and the refusal is worth more than the one line it costs. Each
	// module's own tests register the same way, so no path to being served
	// skips the guard.
	httpx.RegisterModule(mux, verifier, "tickets", func(m *http.ServeMux) {
		tickets.Register(m, tickets.Config{Pool: pool.Pool, Verifier: verifier, Log: log})
	})
	httpx.RegisterModule(mux, verifier, "crm", func(m *http.ServeMux) {
		crm.Register(m, crm.Config{Pool: pool.Pool, Verifier: verifier, Log: log})
	})
	httpx.RegisterModule(mux, verifier, "aiusage", func(m *http.ServeMux) {
		aiusage.Register(m, aiusage.Config{Pool: pool.Pool, Verifier: verifier, Log: log})
	})

	server := &http.Server{
		Addr: ":" + cfg.Port,
		// Wrapped after registration, not before: WithMiddleware takes a
		// finished handler, and a mux that had already been wrapped could not
		// have had modules added to it.
		Handler: httpx.WithMiddleware(mux),
		// A request that has not sent its headers in this long is not a
		// request. Without these an idle connection holds a goroutine
		// indefinitely, which is a slow way to run out of them.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errs := make(chan error, 1)
	go func() {
		log.Info("listening", slog.String("addr", server.Addr))
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
	}

	// Drain in flight requests before the process goes.
	//
	// Knative sends SIGTERM and then waits; without this, requests being served
	// at that moment are severed. The timeout bounds the wait so a stuck
	// request cannot block the rollout indefinitely.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		return err
	}
	log.Info("stopped")
	return nil
}
