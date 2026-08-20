package aiusage

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/ingest"
)

// The ledger's write side, as a whole.
//
// Three moving parts, one process: an OTLP endpoint the gateway exports to, a
// JetStream stream it publishes into, and a durable consumer that writes to
// Postgres. They are one binary because they are one pipeline with one owner,
// and separate from the API because their failure modes must not be shared —
// the console has to keep answering while ingest is behind.

// IngestConfig is what the ingest binary needs from its composition root.
type IngestConfig struct {
	Pool *pgxpool.Pool
	// NATS URL, e.g. nats://nats.messaging.svc.cluster.local:4222.
	NatsURL string
	// Address the OTLP receiver listens on.
	Addr string
	Log  *slog.Logger
}

// RunIngest serves until the context is cancelled.
func RunIngest(ctx context.Context, cfg IngestConfig) error {
	conn, err := nats.Connect(cfg.NatsURL,
		nats.Name("ai-usage-ingest"),
		// Reconnect forever: a NATS restart must not end the process, or the
		// receiver would start refusing the gateway's exports over a blip.
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return fmt.Errorf("connecting to nats: %w", err)
	}
	defer conn.Drain() //nolint:errcheck // drain on shutdown is best-effort

	js, err := jetstream.New(conn)
	if err != nil {
		return fmt.Errorf("opening jetstream: %w", err)
	}

	stream, err := ingest.EnsureStream(ctx, js)
	if err != nil {
		return err
	}
	consumer, err := ingest.EnsureConsumer(ctx, stream)
	if err != nil {
		return err
	}

	writer := ingest.NewWriter(cfg.Pool)
	server := &http.Server{
		Addr:    cfg.Addr,
		Handler: ingest.NewReceiver(ingest.NewPublisher(js), cfg.Log),
		// The gateway is on the cluster network and batches small payloads;
		// these exist so a stalled exporter cannot hold a connection open.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errs := make(chan error, 1)
	go func() {
		cfg.Log.Info("ai usage ingest listening", "addr", cfg.Addr, "path", ingest.TracesPath)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- fmt.Errorf("otlp receiver: %w", err)
			return
		}
		errs <- nil
	}()

	go func() {
		errs <- ingest.Consume(ctx, consumer, writer, cfg.Log)
	}()

	select {
	case <-ctx.Done():
	case err := <-errs:
		if err != nil {
			shutdown(server, cfg.Log)
			return err
		}
	}

	shutdown(server, cfg.Log)
	return nil
}

func shutdown(server *http.Server, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Error("ai usage ingest: shutdown", "error", err)
	}
}
