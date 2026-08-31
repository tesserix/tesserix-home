package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	authcore "github.com/tesserix/tesserix-home/platform-auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api/handlers"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/bao"
	"github.com/tesserix/tesserix-home/secrets-api/internal/config"
	"github.com/tesserix/tesserix-home/secrets-api/internal/gcpsm"
	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
	"github.com/tesserix/tesserix-home/secrets-api/internal/k8s"
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(log); err != nil {
		log.Error("startup failed", "error", err)
		os.Exit(1)
	}
}

// buildBackends constructs the enabled secret stores. The OpenBao client is
// returned separately because namespace access control is an OpenBao policy
// and has no Secret Manager equivalent.
func buildBackends(cfg config.Config) (*bao.Client, *secrets.Registry, error) {
	var client *bao.Client
	stores := make(map[secrets.Backend]secrets.Store, len(cfg.Backends))

	if cfg.BackendEnabled(secrets.BackendOpenBao) {
		var err error
		client, err = bao.New(bao.Config{
			Address:         cfg.OpenBaoAddr,
			Mount:           cfg.OpenBaoMount,
			Token:           cfg.OpenBaoDevToken,
			KubernetesRole:  cfg.OpenBaoK8sRole,
			KubernetesMount: cfg.OpenBaoK8sMount,
		})
		if err != nil {
			return nil, nil, err
		}
		stores[secrets.BackendOpenBao] = client
	}

	if cfg.BackendEnabled(secrets.BackendGCPSM) {
		google, err := gcpsm.New(gcpsm.Config{ProjectID: cfg.GCPProjectID, Locations: cfg.GCPLocations})
		if err != nil {
			return nil, nil, err
		}
		stores[secrets.BackendGCPSM] = google
	}

	registry, err := secrets.NewRegistry(cfg.DefaultBackend, stores)
	if err != nil {
		return nil, nil, err
	}
	return client, registry, nil
}

func run(log *slog.Logger) error {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client, registry, err := buildBackends(cfg)
	if err != nil {
		return err
	}

	// Discovery is a convenience, not a dependency: outside a cluster the console
	// still serves everything that talks to OpenBao.
	discovery, err := k8s.NewInCluster()
	if err != nil {
		log.Warn("cluster discovery unavailable", "error", err)
		discovery = nil
	}

	// Left nil without a token so the handler refuses proposals outright; a typed
	// nil client would look configured and fail on every call instead.
	var whitelist handlers.Proposer
	var reviews handlers.Reviewer
	if cfg.GitOpsEnabled() {
		github := gitops.NewGitHub(gitops.GitHubConfig{
			Owner:       cfg.GitHubOwner,
			Repo:        cfg.GitHubRepo,
			Branch:      cfg.GitHubBranch,
			Path:        cfg.GitHubValuesPath,
			ProjectPath: cfg.GitHubProjectPath,
			Token:       cfg.GitHubToken,
		})
		whitelist, reviews = github, github
	} else {
		log.Warn("whitelist proposals disabled", "reason", "GITHUB_TOKEN is not set")
	}

	// Discovery is a network call made once at startup, bounded by
	// NewVerifierFromConfig's own timeout so an unreachable-but-not-refusing
	// Zitadel fails the startup instead of hanging it — a stuck rollout reads
	// far worse than a failed one. Authentication is always enabled here:
	// unlike platform-api, secrets-api has no unauthenticated bootstrapping
	// window, and config.Load already refuses to start without
	// ZITADEL_ISSUER/ZITADEL_PROJECT_ID.
	verifier, err := authcore.NewVerifierFromConfig(ctx, authcore.Config{
		Enabled:         true,
		Issuer:          cfg.ZitadelIssuer,
		ProjectID:       cfg.ZitadelProjectID,
		ConsoleClientID: cfg.ConsoleClientID,
		Log:             log,
	})
	if err != nil {
		return fmt.Errorf("zitadel discovery: %w", err)
	}

	log.Info("starting", "port", cfg.Port,
		"backends", cfg.Backends, "defaultBackend", cfg.DefaultBackend)

	srv := api.NewServer(api.Deps{
		Config:    cfg,
		Bao:       client,
		Secrets:   registry,
		Audit:     audit.New(os.Stdout),
		Log:       log,
		Discovery: discovery,
		Whitelist: whitelist,
		Reviews:   reviews,
		Verifier:  verifier,
	})

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
