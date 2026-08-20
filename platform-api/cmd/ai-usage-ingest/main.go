// Command ai-usage-ingest writes the AI usage ledger.
//
// It receives OTLP spans from agentgateway, buffers them in JetStream and
// writes them to Postgres. A separate process from the API because their
// failure modes must not be shared: the console has to keep answering while
// ingest is behind, and a burst of gateway traffic must not contend with an
// operator's page load.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/config"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/database"
)

const (
	defaultAddr    = ":4318"
	defaultNatsURL = "nats://nats.messaging.svc.cluster.local:4222"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	if err := run(log); err != nil {
		log.Error("startup failed", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	// LoadDatabase, not Load: this process serves no authenticated route and has
	// no use for the Zitadel settings Load() would demand.
	db, err := config.LoadDatabase()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := database.Open(ctx, db)
	if err != nil {
		return err
	}
	defer pool.Close()

	log.Info("connected", slog.String("database", db.String()))

	return aiusage.RunIngest(ctx, aiusage.IngestConfig{
		Pool:    pool.Pool,
		NatsURL: env("AI_USAGE_NATS_URL", defaultNatsURL),
		Addr:    env("AI_USAGE_INGEST_ADDR", defaultAddr),
		Log:     log,
	})
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
