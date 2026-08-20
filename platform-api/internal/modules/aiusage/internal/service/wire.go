// Package service holds the AI usage module's operations and the wire shapes it
// answers with.
//
// # The resource is USAGE, not the screen
//
// §2's rule: a module exposes domain resources and the console composes the
// screen. The temptation here is a single `/ai/usage/page` returning everything
// the page renders, because the page renders four things at once. It is
// resisted for the reason §2 gives — the four have different costs and
// different refresh rates, and a caller that only wants the guardrail count
// should not pay for a 30-day cost breakdown.
//
// # Cost is a float, and that is deliberate
//
// The column is numeric(14,6); this renders it as a JSON number. A per-request
// cost is fractions of a cent, and the surface reads it to two decimal places
// after summing thousands of them — a display concern, not an accounting one.
// If this ever becomes an invoice, it moves to minor units as a string, and
// that is a different contract than the one this surface needs.
//
// # snake_case, the estate's spelling.
package service

import (
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/domain"
)

// Tokens mirrors domain.Tokens. `cached_input` is a subset of `input`, so a
// client summing all three double-counts.
type Tokens struct {
	Input       int64 `json:"input"`
	Output      int64 `json:"output"`
	CachedInput int64 `json:"cached_input"`
}

// Window echoes what the answer covers.
//
// Echoed rather than assumed: the caller asked for "24h" and got a bound
// truncated to the hour, so `from` is the only honest answer to "since when",
// and a chart that labelled its axis from the client's own clock would drift
// from the data by up to an hour.
type Window struct {
	Key     string    `json:"key"`
	From    time.Time `json:"from"`
	To      time.Time `json:"to"`
	Bucket  string    `json:"bucket"`
	Seconds int64     `json:"bucket_seconds"`
}

type Totals struct {
	Requests    int64   `json:"requests"`
	Tokens      Tokens  `json:"tokens"`
	CostUSD     float64 `json:"cost_usd"`
	OK          int64   `json:"ok_requests"`
	Blocked     int64   `json:"blocked_requests"`
	RateLimited int64   `json:"rate_limited_requests"`
	Errors      int64   `json:"error_requests"`
	Masked      int64   `json:"masked_requests"`
}

type SeriesPoint struct {
	Bucket   time.Time `json:"bucket"`
	Requests int64     `json:"requests"`
	Tokens   Tokens    `json:"tokens"`
	CostUSD  float64   `json:"cost_usd"`
}

// SummaryPayload is the window's headline: what it cost, and its shape over
// time. Series is included because a total with no shape cannot answer the
// question the surface is opened with — "when did it change" — and the two
// come from one scan of the same rollups.
type SummaryPayload struct {
	Window Window        `json:"window"`
	Totals Totals        `json:"totals"`
	Series []SeriesPoint `json:"series"`
}

type BreakdownRow struct {
	Key      string  `json:"key"`
	Requests int64   `json:"requests"`
	Tokens   Tokens  `json:"tokens"`
	CostUSD  float64 `json:"cost_usd"`
	Errors   int64   `json:"error_requests"`
	Blocked  int64   `json:"blocked_requests"`
}

type BreakdownPayload struct {
	Window Window         `json:"window"`
	By     string         `json:"by"`
	Rows   []BreakdownRow `json:"rows"`
}

type GuardrailRow struct {
	Rule     string    `json:"rule"`
	Action   string    `json:"action"`
	Product  string    `json:"product"`
	Requests int64     `json:"requests"`
	LastSeen time.Time `json:"last_seen"`
}

// GuardrailsPayload carries the rate-limit and block counts alongside the rule
// detail because they answer one question together: a spike in blocks with no
// rule attached means the gateway refused traffic before promptGuard ran.
type GuardrailsPayload struct {
	Window      Window         `json:"window"`
	Blocked     int64          `json:"blocked_requests"`
	Masked      int64          `json:"masked_requests"`
	RateLimited int64          `json:"rate_limited_requests"`
	Rules       []GuardrailRow `json:"rules"`
}

type Event struct {
	SpanID          string    `json:"span_id"`
	TraceID         string    `json:"trace_id"`
	OccurredAt      time.Time `json:"occurred_at"`
	Gateway         string    `json:"gateway"`
	Product         string    `json:"product"`
	Capability      *string   `json:"capability"`
	Provider        string    `json:"provider"`
	RequestModel    string    `json:"request_model"`
	ResponseModel   *string   `json:"response_model"`
	Tokens          Tokens    `json:"tokens"`
	CostUSD         float64   `json:"cost_usd"`
	CostSource      string    `json:"cost_source"`
	StatusCode      int       `json:"status_code"`
	Outcome         string    `json:"outcome"`
	GuardrailAction *string   `json:"guardrail_action"`
	GuardrailRule   *string   `json:"guardrail_rule"`
	LatencyMS       *int      `json:"latency_ms"`
}

type EventsPayload struct {
	Window Window  `json:"window"`
	Events []Event `json:"events"`
}

// utc pins the wire's timezone. pgx decodes timestamptz into time.Local — the
// PROCESS's zone — so without this the same row serialises differently on a
// laptop and in a container. The tickets module found this by running the
// service; the golden files mask the value, which masks the offset too.
func utc(t time.Time) time.Time { return t.UTC() }

func toTokens(t domain.Tokens) Tokens {
	return Tokens{Input: t.Input, Output: t.Output, CachedInput: t.Cached}
}

func toWindow(w domain.Window, from, to time.Time) Window {
	return Window{
		Key:     w.Key,
		From:    utc(from),
		To:      utc(to),
		Bucket:  w.Bucket.String(),
		Seconds: int64(w.Bucket / time.Second),
	}
}

func toTotals(t domain.Totals) Totals {
	return Totals{
		Requests:    t.Requests,
		Tokens:      toTokens(t.Tokens),
		CostUSD:     t.CostUSD,
		OK:          t.OK,
		Blocked:     t.Blocked,
		RateLimited: t.RateLimited,
		Errors:      t.Errors,
		Masked:      t.Masked,
	}
}

// The `make(..., 0, n)` in each of these is what makes an empty result
// serialise as `[]` rather than `null` — and every one of these surfaces
// reaches empty on a quiet window, which is the response a client is least
// likely to have exercised.
func toSeries(points []domain.SeriesPoint) []SeriesPoint {
	out := make([]SeriesPoint, 0, len(points))
	for _, p := range points {
		out = append(out, SeriesPoint{
			Bucket:   utc(p.Bucket),
			Requests: p.Requests,
			Tokens:   toTokens(p.Tokens),
			CostUSD:  p.CostUSD,
		})
	}
	return out
}

func toBreakdown(rows []domain.BreakdownRow) []BreakdownRow {
	out := make([]BreakdownRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, BreakdownRow{
			Key:      r.Key,
			Requests: r.Requests,
			Tokens:   toTokens(r.Tokens),
			CostUSD:  r.CostUSD,
			Errors:   r.Errors,
			Blocked:  r.Blocked,
		})
	}
	return out
}

func toGuardrails(rows []domain.GuardrailRow) []GuardrailRow {
	out := make([]GuardrailRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, GuardrailRow{
			Rule:     r.Rule,
			Action:   r.Action,
			Product:  r.Product,
			Requests: r.Requests,
			LastSeen: utc(r.LastSeen),
		})
	}
	return out
}

func toEvents(rows []domain.Event) []Event {
	out := make([]Event, 0, len(rows))
	for _, e := range rows {
		out = append(out, Event{
			SpanID:          e.SpanID,
			TraceID:         e.TraceID,
			OccurredAt:      utc(e.OccurredAt),
			Gateway:         e.Gateway,
			Product:         e.Product,
			Capability:      e.Capability,
			Provider:        e.Provider,
			RequestModel:    e.RequestModel,
			ResponseModel:   e.ResponseModel,
			Tokens:          toTokens(e.Tokens),
			CostUSD:         e.CostUSD,
			CostSource:      e.CostSource,
			StatusCode:      e.StatusCode,
			Outcome:         string(e.Outcome),
			GuardrailAction: e.GuardrailAction,
			GuardrailRule:   e.GuardrailRule,
			LatencyMS:       e.LatencyMS,
		})
	}
	return out
}
