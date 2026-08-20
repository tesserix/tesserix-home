// Package domain holds the AI usage module's query vocabulary: the time
// windows and breakdown axes the surface is allowed to ask for.
//
// They are a closed set on purpose. Both end up in SQL — a window as a bound,
// an axis as a GROUP BY column — so an open string would be either an injection
// or a silent empty result, and neither is a thing to discover in production.
package domain

import (
	"fmt"
	"time"
)

// Window is a lookback period ending now.
type Window struct {
	Key      string
	Duration time.Duration
	// Bucket is the granularity the series is returned at. An hour of traffic
	// is one point over 24h and a rounding error over 30d, so the bucket widens
	// with the window rather than returning 720 points nobody can read.
	Bucket time.Duration
}

var windows = map[string]Window{
	"24h": {Key: "24h", Duration: 24 * time.Hour, Bucket: time.Hour},
	"7d":  {Key: "7d", Duration: 7 * 24 * time.Hour, Bucket: 6 * time.Hour},
	"30d": {Key: "30d", Duration: 30 * 24 * time.Hour, Bucket: 24 * time.Hour},
}

// DefaultWindow is what an unspecified `window` means.
//
// 24h rather than 7d: the question this surface is opened with is almost always
// "what is happening now", and the cheapest read is the right default.
const DefaultWindow = "24h"

// ParseWindow resolves a window key.
//
// 30 days is the ceiling because that is how long raw events are kept
// (migration 0030); a 90-day window would silently answer from rollups alone
// and the events tab would disagree with the totals above it.
func ParseWindow(key string) (Window, error) {
	if key == "" {
		key = DefaultWindow
	}
	w, ok := windows[key]
	if !ok {
		return Window{}, fmt.Errorf("%q is not a window: use 24h, 7d or 30d", key)
	}
	return w, nil
}

// Since is the window's lower bound, truncated to the hour.
//
// Truncated because the rollups are hourly: an un-truncated bound would take
// half of the oldest bucket's total, which is not half of its traffic.
func (w Window) Since(now time.Time) time.Time {
	return now.UTC().Add(-w.Duration).Truncate(time.Hour)
}

// Dimension is an axis a breakdown groups by.
type Dimension string

const (
	ByProduct    Dimension = "product"
	ByProvider   Dimension = "provider"
	ByModel      Dimension = "model"
	ByCapability Dimension = "capability"
	ByGateway    Dimension = "gateway"
)

// Column is the rollup column the dimension groups by.
//
// The mapping exists so the axis a caller names and the column it reaches are
// not the same string: `model` is friendlier than `request_model`, and the
// column can be re-pointed without changing the contract.
func (d Dimension) Column() (string, bool) {
	switch d {
	case ByProduct:
		return "product", true
	case ByProvider:
		return "provider", true
	case ByModel:
		return "request_model", true
	case ByCapability:
		return "capability", true
	case ByGateway:
		return "gateway", true
	default:
		return "", false
	}
}

// ParseDimension resolves a breakdown axis.
func ParseDimension(raw string) (Dimension, error) {
	if raw == "" {
		return ByProduct, nil
	}
	d := Dimension(raw)
	if _, ok := d.Column(); !ok {
		return "", fmt.Errorf("%q is not a breakdown axis: use product, provider, model, capability or gateway", raw)
	}
	return d, nil
}

// Outcome is how a request ended, mirroring ai_usage_events.outcome.
type Outcome string

const (
	OutcomeOK               Outcome = "ok"
	OutcomeGuardrailBlocked Outcome = "guardrail_blocked"
	OutcomeRateLimited      Outcome = "rate_limited"
	OutcomeProviderError    Outcome = "provider_error"
	OutcomeGatewayError     Outcome = "gateway_error"
)

var outcomes = []Outcome{
	OutcomeOK, OutcomeGuardrailBlocked, OutcomeRateLimited,
	OutcomeProviderError, OutcomeGatewayError,
}

// ParseOutcome resolves an outcome filter.
func ParseOutcome(raw string) (Outcome, error) {
	for _, o := range outcomes {
		if string(o) == raw {
			return o, nil
		}
	}
	return "", fmt.Errorf("%q is not an outcome", raw)
}
