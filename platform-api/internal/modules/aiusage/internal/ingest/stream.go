package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// The JetStream buffer between the gateway and the ledger.
//
// # Why a stream at all
//
// The gateway exports telemetry as fast as it serves traffic and cannot be
// asked to wait: an OTLP endpoint that blocks on Postgres would add the
// database's latency to every LLM request, and an endpoint that drops on a
// database outage would lose the spend that outage caused. JetStream takes the
// export at memory speed, persists it, and lets the writer fall behind and
// catch up.
//
// # Why replay is safe
//
// Publishes carry the span id as the message id, so the stream itself refuses
// an obvious duplicate inside the dedupe window, and the ledger's span-id
// primary key refuses the rest. A consumer may therefore ack late, crash, and
// redeliver without inflating a single figure.
const (
	StreamName    = "AI_USAGE"
	SubjectPrefix = "ai.usage."
	ConsumerName  = "ai-usage-writer"
)

// Retention. The stream is a buffer, not the record — the record is Postgres —
// so it keeps only enough history to survive a long outage.
const (
	streamMaxAge     = 72 * time.Hour
	streamDuplicates = 10 * time.Minute
)

// EnsureStream creates or updates the stream this ingest reads.
//
// Idempotent, and called on every start rather than left to an operator: a
// consumer whose stream does not exist fails at the moment traffic arrives,
// which is the worst time to discover a missing bootstrap step.
func EnsureStream(ctx context.Context, js jetstream.JetStream) (jetstream.Stream, error) {
	stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:        StreamName,
		Description: "AI usage spans from agentgateway, awaiting the ledger writer",
		Subjects:    []string{SubjectPrefix + ">"},
		Storage:     jetstream.FileStorage,
		Retention:   jetstream.LimitsPolicy,
		Discard:     jetstream.DiscardOld,
		MaxAge:      streamMaxAge,
		Duplicates:  streamDuplicates,
	})
	if err != nil {
		return nil, fmt.Errorf("ensuring stream %s: %w", StreamName, err)
	}
	return stream, nil
}

// EnsureConsumer creates or updates the durable this ingest pulls from.
//
// Durable and explicit-ack: an ephemeral consumer would restart at the end of
// the stream, so every restart would lose whatever had not been written yet.
func EnsureConsumer(ctx context.Context, stream jetstream.Stream) (jetstream.Consumer, error) {
	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:   ConsumerName,
		AckPolicy: jetstream.AckExplicitPolicy,
		AckWait:   30 * time.Second,
		// Five attempts, then the message is the stream's problem rather than
		// an endless redelivery loop starving everything behind it.
		MaxDeliver:    5,
		FilterSubject: SubjectPrefix + ">",
	})
	if err != nil {
		return nil, fmt.Errorf("ensuring consumer %s: %w", ConsumerName, err)
	}
	return consumer, nil
}

// Subject routes a record, so a future consumer can filter by product without
// re-reading everything.
func Subject(record Record) string {
	product := strings.Map(func(r rune) rune {
		// NATS subject tokens are dot-delimited and whitespace-free; anything
		// else would silently create a subject nobody can subscribe to.
		if r == '.' || r == '*' || r == '>' || r == ' ' {
			return '-'
		}
		return r
	}, record.Product)
	if product == "" {
		product = "unattributed"
	}
	return SubjectPrefix + product
}

// Publisher puts records on the stream.
type Publisher struct {
	js jetstream.JetStream
}

func NewPublisher(js jetstream.JetStream) *Publisher {
	return &Publisher{js: js}
}

// Publish stores one record, keyed by its span id so a retried export does not
// become a second row.
func (p *Publisher) Publish(ctx context.Context, record Record) error {
	payload, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encoding record %s: %w", record.SpanID, err)
	}
	if _, err := p.js.Publish(ctx, Subject(record), payload,
		jetstream.WithMsgID(record.SpanID)); err != nil {
		return fmt.Errorf("publishing record %s: %w", record.SpanID, err)
	}
	return nil
}

// Consume drains the durable into the ledger until the context is cancelled.
//
// A message that fails to decode is terminated rather than nak'd: it will never
// decode, and redelivering it five times only delays everything behind it. A
// message that fails to write is nak'd, because the usual cause is the database
// being briefly unavailable, and that is exactly what the buffer is for.
func Consume(ctx context.Context, consumer jetstream.Consumer, writer *Writer, log *slog.Logger) error {
	sub, err := consumer.Consume(func(msg jetstream.Msg) {
		var record Record
		if err := json.Unmarshal(msg.Data(), &record); err != nil {
			log.Error("ai usage: undecodable message dropped", "error", err)
			_ = msg.Term()
			return
		}
		stored, err := writer.Write(ctx, record)
		if err != nil {
			log.Error("ai usage: write failed, will retry", "span_id", record.SpanID, "error", err)
			_ = msg.Nak()
			return
		}
		if !stored {
			log.Debug("ai usage: already recorded", "span_id", record.SpanID)
		}
		_ = msg.Ack()
	})
	if err != nil {
		return fmt.Errorf("consuming %s: %w", ConsumerName, err)
	}
	defer sub.Stop()

	<-ctx.Done()
	return nil
}
