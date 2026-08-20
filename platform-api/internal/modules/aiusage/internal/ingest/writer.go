package ingest

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Writer lands records in the ledger.
type Writer struct {
	pool *pgxpool.Pool
}

func NewWriter(pool *pgxpool.Pool) *Writer {
	return &Writer{pool: pool}
}

// Write stores one request and folds it into its hourly bucket, reporting
// whether it was new.
//
// The event insert and the rollup increment share one transaction, which is the
// invariant the whole surface rests on: a rollup cannot count a request the
// events table does not have, and cannot miss one it does. Redelivery is
// answered by the span-id primary key — a duplicate does not increment
// anything, so at-least-once delivery does not become an inflated bill.
func (w *Writer) Write(ctx context.Context, record Record) (bool, error) {
	if record.SpanID == "" {
		return false, fmt.Errorf("write ai usage: the span carries no id")
	}

	var stored bool
	err := pgx.BeginFunc(ctx, w.pool, func(tx pgx.Tx) error {
		priced, err := w.price(ctx, tx, record)
		if err != nil {
			return err
		}

		inserted, err := insertEvent(ctx, tx, priced)
		if err != nil {
			return err
		}
		if !inserted {
			return nil
		}
		stored = true
		return upsertHourly(ctx, tx, priced)
	})
	if err != nil {
		return false, fmt.Errorf("write ai usage %s: %w", record.SpanID, err)
	}
	return stored, nil
}

// price fills in a cost the gateway did not supply.
//
// Effective-dated on the request's own timestamp, not on now(): a replayed
// week-old span must be priced at the rate card that was in force when it ran,
// or a replay would silently restate history.
func (w *Writer) price(ctx context.Context, tx pgx.Tx, record Record) (Record, error) {
	if record.CostSource != CostUnpriced {
		return record, nil
	}

	model := firstNonEmpty(record.ResponseModel, record.RequestModel)
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (token_kind) token_kind, usd_per_million
		FROM ai_model_prices
		WHERE provider = $1 AND model = $2 AND effective_from <= $3
		ORDER BY token_kind, effective_from DESC`,
		record.Provider, model, record.OccurredAt)
	if err != nil {
		return record, fmt.Errorf("reading prices for %s/%s: %w", record.Provider, model, err)
	}
	defer rows.Close()

	prices := map[string]float64{}
	for rows.Next() {
		var kind string
		var perMillion float64
		if err := rows.Scan(&kind, &perMillion); err != nil {
			return record, fmt.Errorf("scanning price: %w", err)
		}
		prices[kind] = perMillion
	}
	if err := rows.Err(); err != nil {
		return record, fmt.Errorf("reading prices: %w", err)
	}
	if len(prices) == 0 {
		return record, nil
	}

	// Cached tokens are a subset of input, so the uncached remainder is what
	// the input rate applies to. A provider with no separate cache rate is
	// billed at the input rate, which is what "no discount" means.
	cachedRate, ok := prices["cached_input"]
	if !ok {
		cachedRate = prices["input"]
	}
	uncached := record.InputTokens - record.CachedInputTokens

	record.CostUSD = (float64(uncached)*prices["input"] +
		float64(record.CachedInputTokens)*cachedRate +
		float64(record.OutputTokens)*prices["output"]) / 1_000_000
	record.CostSource = CostFromCatalog
	return record, nil
}

func insertEvent(ctx context.Context, tx pgx.Tx, record Record) (bool, error) {
	var latency *int
	if record.LatencyMS >= 0 {
		value := record.LatencyMS
		latency = &value
	}

	rows, err := tx.Query(ctx, `
		INSERT INTO ai_usage_events (
			span_id, trace_id, occurred_at, gateway, product, capability,
			provider, request_model, response_model,
			input_tokens, output_tokens, cached_input_tokens,
			cost_usd, cost_source, status_code, outcome,
			guardrail_action, guardrail_rule, latency_ms
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9,
			$10, $11, $12,
			$13, $14, $15, $16,
			$17, $18, $19
		)
		ON CONFLICT (span_id) DO NOTHING
		RETURNING span_id`,
		record.SpanID, record.TraceID, record.OccurredAt, record.Gateway, record.Product,
		nullable(record.Capability),
		record.Provider, record.RequestModel, nullable(record.ResponseModel),
		record.InputTokens, record.OutputTokens, record.CachedInputTokens,
		record.CostUSD, record.CostSource, record.StatusCode, record.Outcome,
		nullable(record.GuardrailAction), nullable(record.GuardrailRule), latency)
	if err != nil {
		return false, fmt.Errorf("inserting event: %w", err)
	}
	defer rows.Close()

	inserted := rows.Next()
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("inserting event: %w", err)
	}
	return inserted, nil
}

func upsertHourly(ctx context.Context, tx pgx.Tx, record Record) error {
	counters := map[string]int{
		OutcomeOK:               0,
		OutcomeGuardrailBlocked: 0,
		OutcomeRateLimited:      0,
	}
	counters[record.Outcome] = 1
	errors := 0
	if record.Outcome == OutcomeProviderError || record.Outcome == OutcomeGatewayError {
		errors = 1
	}
	masked := 0
	if record.GuardrailAction == GuardrailMask {
		masked = 1
	}

	_, err := tx.Exec(ctx, `
		INSERT INTO ai_usage_hourly (
			bucket, gateway, product, capability, provider, request_model,
			requests, input_tokens, output_tokens, cached_input_tokens, cost_usd,
			ok_requests, blocked_requests, rate_limited_requests, error_requests, masked_requests
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			1, $7, $8, $9, $10,
			$11, $12, $13, $14, $15
		)
		ON CONFLICT (bucket, gateway, product, capability, provider, request_model) DO UPDATE SET
			requests = ai_usage_hourly.requests + 1,
			input_tokens = ai_usage_hourly.input_tokens + EXCLUDED.input_tokens,
			output_tokens = ai_usage_hourly.output_tokens + EXCLUDED.output_tokens,
			cached_input_tokens = ai_usage_hourly.cached_input_tokens + EXCLUDED.cached_input_tokens,
			cost_usd = ai_usage_hourly.cost_usd + EXCLUDED.cost_usd,
			ok_requests = ai_usage_hourly.ok_requests + EXCLUDED.ok_requests,
			blocked_requests = ai_usage_hourly.blocked_requests + EXCLUDED.blocked_requests,
			rate_limited_requests = ai_usage_hourly.rate_limited_requests + EXCLUDED.rate_limited_requests,
			error_requests = ai_usage_hourly.error_requests + EXCLUDED.error_requests,
			masked_requests = ai_usage_hourly.masked_requests + EXCLUDED.masked_requests`,
		record.OccurredAt.UTC().Truncate(time.Hour), record.Gateway, record.Product,
		record.Capability, record.Provider, record.RequestModel,
		record.InputTokens, record.OutputTokens, record.CachedInputTokens, record.CostUSD,
		counters[OutcomeOK], counters[OutcomeGuardrailBlocked], counters[OutcomeRateLimited],
		errors, masked)
	if err != nil {
		return fmt.Errorf("rolling up the hour: %w", err)
	}
	return nil
}

// nullable keeps an absent value out of the table as NULL. An empty string in
// `capability` would read as a capability named "", which is a different claim
// from "the gateway did not say".
func nullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
