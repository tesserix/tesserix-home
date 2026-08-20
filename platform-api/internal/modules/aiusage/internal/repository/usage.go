// Package repository reads the AI usage ledger.
//
// Aggregates read ai_usage_hourly, never the raw events: a 30-day cost
// breakdown over raw rows scans every LLM request the estate has made, and over
// the rollups it is a few thousand rows. Only the tail and the guardrail
// detail — which need per-request facts the rollup does not carry — read
// ai_usage_events.
package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/domain"
)

type Repository struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

// Filter narrows every read to the same axes the console filters on.
//
// Zero values mean "no narrowing", which is why Product is a plain string and
// not a pointer: there is no product whose name is the empty string.
type Filter struct {
	Product  string
	Provider string
}

func (f Filter) clauses(args *[]any) string {
	var out strings.Builder
	if f.Product != "" {
		*args = append(*args, f.Product)
		fmt.Fprintf(&out, " AND product = $%d", len(*args))
	}
	if f.Provider != "" {
		*args = append(*args, f.Provider)
		fmt.Fprintf(&out, " AND provider = $%d", len(*args))
	}
	return out.String()
}

// Totals aggregates the window.
func (r *Repository) Totals(ctx context.Context, since time.Time, f Filter) (domain.Totals, error) {
	args := []any{since}
	query := `
		SELECT
			COALESCE(SUM(requests), 0),
			COALESCE(SUM(input_tokens), 0),
			COALESCE(SUM(output_tokens), 0),
			COALESCE(SUM(cached_input_tokens), 0),
			COALESCE(SUM(cost_usd), 0)::float8,
			COALESCE(SUM(ok_requests), 0),
			COALESCE(SUM(blocked_requests), 0),
			COALESCE(SUM(rate_limited_requests), 0),
			COALESCE(SUM(error_requests), 0),
			COALESCE(SUM(masked_requests), 0)
		FROM ai_usage_hourly
		WHERE bucket >= $1` + f.clauses(&args)

	var t domain.Totals
	err := r.pool.QueryRow(ctx, query, args...).Scan(
		&t.Requests, &t.Tokens.Input, &t.Tokens.Output, &t.Tokens.Cached, &t.CostUSD,
		&t.OK, &t.Blocked, &t.RateLimited, &t.Errors, &t.Masked,
	)
	if err != nil {
		return domain.Totals{}, fmt.Errorf("aggregate ai usage: %w", err)
	}
	return t, nil
}

// Series buckets the window at the given granularity.
//
// date_bin anchors on `since` rather than on the epoch so the newest bucket
// ends at the window's end. Anchored on the epoch, a 6-hour bucket would cut
// across the boundary and the last point would be a partial one that looks like
// a drop in traffic.
func (r *Repository) Series(ctx context.Context, since time.Time, bucket time.Duration, f Filter) ([]domain.SeriesPoint, error) {
	args := []any{since, bucket}
	query := `
		SELECT
			date_bin($2::interval, bucket, $1) AS point,
			COALESCE(SUM(requests), 0),
			COALESCE(SUM(input_tokens), 0),
			COALESCE(SUM(output_tokens), 0),
			COALESCE(SUM(cached_input_tokens), 0),
			COALESCE(SUM(cost_usd), 0)::float8
		FROM ai_usage_hourly
		WHERE bucket >= $1` + f.clauses(&args) + `
		GROUP BY point
		ORDER BY point`

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("series ai usage: %w", err)
	}
	defer rows.Close()

	var out []domain.SeriesPoint
	for rows.Next() {
		var p domain.SeriesPoint
		if err := rows.Scan(&p.Bucket, &p.Requests, &p.Tokens.Input, &p.Tokens.Output, &p.Tokens.Cached, &p.CostUSD); err != nil {
			return nil, fmt.Errorf("series ai usage: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Breakdown groups the window by one axis, dearest first.
func (r *Repository) Breakdown(ctx context.Context, since time.Time, d domain.Dimension, f Filter) ([]domain.BreakdownRow, error) {
	column, ok := d.Column()
	if !ok {
		// Unreachable through the handler, which parses the axis first. A
		// panic-free guard rather than string-formatting an unvalidated column
		// into SQL if a second caller ever appears.
		return nil, fmt.Errorf("breakdown ai usage: %q is not an axis", d)
	}

	args := []any{since}
	query := `
		SELECT
			` + column + ` AS axis,
			COALESCE(SUM(requests), 0),
			COALESCE(SUM(input_tokens), 0),
			COALESCE(SUM(output_tokens), 0),
			COALESCE(SUM(cached_input_tokens), 0),
			COALESCE(SUM(cost_usd), 0)::float8,
			COALESCE(SUM(error_requests), 0),
			COALESCE(SUM(blocked_requests), 0)
		FROM ai_usage_hourly
		WHERE bucket >= $1` + f.clauses(&args) + `
		GROUP BY axis
		ORDER BY SUM(cost_usd) DESC, SUM(requests) DESC, axis`

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("breakdown ai usage: %w", err)
	}
	defer rows.Close()

	var out []domain.BreakdownRow
	for rows.Next() {
		var row domain.BreakdownRow
		if err := rows.Scan(&row.Key, &row.Requests, &row.Tokens.Input, &row.Tokens.Output,
			&row.Tokens.Cached, &row.CostUSD, &row.Errors, &row.Blocked); err != nil {
			return nil, fmt.Errorf("breakdown ai usage: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Guardrails lists which rules fired, and on whose traffic.
//
// From the raw events because the rule NAME is per-request: the rollup counts
// blocked requests, it cannot say the card-number rule was the one that fired.
func (r *Repository) Guardrails(ctx context.Context, since time.Time, f Filter) ([]domain.GuardrailRow, error) {
	args := []any{since}
	query := `
		SELECT
			COALESCE(guardrail_rule, ''),
			guardrail_action,
			product,
			COUNT(*),
			MAX(occurred_at)
		FROM ai_usage_events
		WHERE occurred_at >= $1
		  AND guardrail_action IS NOT NULL` + f.clauses(&args) + `
		GROUP BY guardrail_rule, guardrail_action, product
		ORDER BY COUNT(*) DESC, guardrail_action, product`

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("guardrails ai usage: %w", err)
	}
	defer rows.Close()

	var out []domain.GuardrailRow
	for rows.Next() {
		var row domain.GuardrailRow
		if err := rows.Scan(&row.Rule, &row.Action, &row.Product, &row.Requests, &row.LastSeen); err != nil {
			return nil, fmt.Errorf("guardrails ai usage: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// EventFilter narrows the tail.
type EventFilter struct {
	Filter
	Outcome domain.Outcome
}

// Events is the newest requests first, capped at limit.
func (r *Repository) Events(ctx context.Context, since time.Time, limit int, f EventFilter) ([]domain.Event, error) {
	args := []any{since}
	where := f.Filter.clauses(&args)
	if f.Outcome != "" {
		args = append(args, string(f.Outcome))
		where += fmt.Sprintf(" AND outcome = $%d", len(args))
	}
	args = append(args, limit)

	query := `
		SELECT span_id, trace_id, occurred_at, gateway, product, capability,
		       provider, request_model, response_model,
		       input_tokens, output_tokens, cached_input_tokens,
		       cost_usd::float8, cost_source, status_code, outcome,
		       guardrail_action, guardrail_rule, latency_ms
		FROM ai_usage_events
		WHERE occurred_at >= $1` + where + `
		ORDER BY occurred_at DESC, span_id DESC
		LIMIT $` + fmt.Sprint(len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("events ai usage: %w", err)
	}
	defer rows.Close()

	out := []domain.Event{}
	for rows.Next() {
		var e domain.Event
		var outcome string
		if err := rows.Scan(
			&e.SpanID, &e.TraceID, &e.OccurredAt, &e.Gateway, &e.Product, &e.Capability,
			&e.Provider, &e.RequestModel, &e.ResponseModel,
			&e.Tokens.Input, &e.Tokens.Output, &e.Tokens.Cached,
			&e.CostUSD, &e.CostSource, &e.StatusCode, &outcome,
			&e.GuardrailAction, &e.GuardrailRule, &e.LatencyMS,
		); err != nil {
			return nil, fmt.Errorf("events ai usage: %w", err)
		}
		e.Outcome = domain.Outcome(outcome)
		out = append(out, e)
	}
	return out, rows.Err()
}
