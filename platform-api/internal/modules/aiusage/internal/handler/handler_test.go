package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// The module is exercised through its real router, its real verifier and a real
// database. Only the token's signature is faked.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:   subjectOperator,
		Email:     "operator@tesserix.test",
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

const jwtShaped = "header.payload.signature"

type api struct {
	handler http.Handler
	pool    *pgxpool.Pool
	t       *testing.T
	// hour is the top of the current hour, the anchor every fixture is placed
	// relative to. Pinned once per test so a run that crosses an hour boundary
	// cannot put half the fixtures in a different bucket from the other half.
	hour time.Time
}

func serve(t *testing.T) *api { return serveAs(t, "read", "platform") }

func serveAs(t *testing.T, roles ...string) *api {
	t.Helper()
	pool := testdb.New(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	httpx.RegisterModule(mux, verifier, "aiusage", func(m *http.ServeMux) {
		aiusage.Register(m, aiusage.Config{Pool: pool, Verifier: verifier, Log: log})
	})

	return &api{
		handler: httpx.WithMiddleware(mux),
		pool:    pool,
		t:       t,
		hour:    time.Now().UTC().Truncate(time.Hour),
	}
}

type rollup struct {
	bucketAgo   time.Duration
	product     string
	provider    string
	model       string
	capability  string
	requests    int64
	input       int64
	output      int64
	cached      int64
	cost        float64
	ok          int64
	blocked     int64
	rateLimited int64
	errors      int64
	masked      int64
}

func (a *api) seedRollup(r rollup) {
	a.t.Helper()
	_, err := a.pool.Exec(context.Background(), `
		INSERT INTO ai_usage_hourly (
			bucket, gateway, product, capability, provider, request_model,
			requests, input_tokens, output_tokens, cached_input_tokens, cost_usd,
			ok_requests, blocked_requests, rate_limited_requests, error_requests, masked_requests
		) VALUES ($1, 'kora-ai', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
		a.hour.Add(-r.bucketAgo), r.product, r.capability, r.provider, r.model,
		r.requests, r.input, r.output, r.cached, r.cost,
		r.ok, r.blocked, r.rateLimited, r.errors, r.masked,
	)
	if err != nil {
		a.t.Fatalf("seeding rollup: %v", err)
	}
}

type event struct {
	spanID     string
	ago        time.Duration
	product    string
	provider   string
	model      string
	outcome    string
	action     string
	rule       string
	input      int64
	output     int64
	cost       float64
	statusCode int
}

func (a *api) seedEvent(e event) {
	a.t.Helper()
	var action, rule any
	if e.action != "" {
		action, rule = e.action, e.rule
	}
	status := e.statusCode
	if status == 0 {
		status = 200
	}
	_, err := a.pool.Exec(context.Background(), `
		INSERT INTO ai_usage_events (
			span_id, trace_id, occurred_at, gateway, product, capability,
			provider, request_model, response_model,
			input_tokens, output_tokens, cached_input_tokens,
			cost_usd, cost_source, status_code, outcome,
			guardrail_action, guardrail_rule, latency_ms
		) VALUES ($1, 'trace-'||$1, $2, 'kora-ai', $3, 'summarise',
			$4, $5, $5, $6, $7, 0, $8, 'catalog', $9, $10, $11, $12, 412)`,
		e.spanID, a.hour.Add(-e.ago), e.product,
		e.provider, e.model, e.input, e.output, e.cost, status, e.outcome, action, rule,
	)
	if err != nil {
		a.t.Fatalf("seeding event: %v", err)
	}
}

func (a *api) get(path string) *httptest.ResponseRecorder {
	a.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	return rec
}

// data unwraps the success envelope, failing the test if the response is not
// one — an assertion that reads `data` out of an error body would report a
// missing field rather than the 500 that caused it.
func (a *api) data(rec *httptest.ResponseRecorder) map[string]any {
	a.t.Helper()
	if rec.Code != http.StatusOK {
		a.t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Success bool           `json:"success"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		a.t.Fatalf("decoding response: %v (%s)", err, rec.Body.String())
	}
	if !envelope.Success {
		a.t.Fatalf("expected success, got %s", rec.Body.String())
	}
	return envelope.Data
}

func number(t *testing.T, data map[string]any, path ...string) float64 {
	t.Helper()
	var current any = data
	for _, key := range path {
		node, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("%v: %q is not under an object", path, key)
		}
		current = node[key]
	}
	value, ok := current.(float64)
	if !ok {
		t.Fatalf("%v is %T, not a number", path, current)
	}
	return value
}

func TestSummaryCountsOnlyTheWindow(t *testing.T) {
	a := serve(t)
	a.seedRollup(rollup{bucketAgo: time.Hour, product: "kora", provider: "vertex", model: "gemini-2.5-pro",
		requests: 10, input: 1000, output: 200, cached: 300, cost: 1.5, ok: 9, errors: 1})
	// Outside a 24h window, inside 7d — the row that proves the bound is real.
	a.seedRollup(rollup{bucketAgo: 48 * time.Hour, product: "kora", provider: "vertex", model: "gemini-2.5-pro",
		requests: 99, input: 99000, output: 9900, cost: 42, ok: 99})

	day := a.data(a.get("/v1/ai/usage/summary?window=24h"))
	if got := number(t, day, "totals", "requests"); got != 10 {
		t.Fatalf("24h requests = %v, want 10", got)
	}
	if got := number(t, day, "totals", "cost_usd"); got != 1.5 {
		t.Fatalf("24h cost = %v, want 1.5", got)
	}
	if got := number(t, day, "totals", "tokens", "cached_input"); got != 300 {
		t.Fatalf("24h cached tokens = %v, want 300", got)
	}

	week := a.data(a.get("/v1/ai/usage/summary?window=7d"))
	if got := number(t, week, "totals", "requests"); got != 109 {
		t.Fatalf("7d requests = %v, want 109", got)
	}
}

func TestSummarySeriesIsBucketedAndOrdered(t *testing.T) {
	a := serve(t)
	a.seedRollup(rollup{bucketAgo: 3 * time.Hour, product: "kora", provider: "vertex", model: "m", requests: 1, cost: 0.1})
	a.seedRollup(rollup{bucketAgo: time.Hour, product: "kora", provider: "vertex", model: "m", requests: 2, cost: 0.2})

	data := a.data(a.get("/v1/ai/usage/summary?window=24h"))
	series, ok := data["series"].([]any)
	if !ok {
		t.Fatalf("series is %T, not an array", data["series"])
	}
	if len(series) != 2 {
		t.Fatalf("series has %d points, want 2 (one per seeded hour)", len(series))
	}

	first := series[0].(map[string]any)
	second := series[1].(map[string]any)
	if first["bucket"].(string) >= second["bucket"].(string) {
		t.Fatalf("series is not ascending: %v then %v", first["bucket"], second["bucket"])
	}
	if first["requests"].(float64) != 1 || second["requests"].(float64) != 2 {
		t.Fatalf("points carry the wrong counts: %v, %v", first["requests"], second["requests"])
	}
}

func TestSummaryOnAQuietWindowIsZeroesAndAnEmptyArray(t *testing.T) {
	a := serve(t)

	data := a.data(a.get("/v1/ai/usage/summary"))
	if got := number(t, data, "totals", "requests"); got != 0 {
		t.Fatalf("requests = %v, want 0", got)
	}
	// `[]`, never null: a client typing this as an array meets its type error
	// on exactly the response it is least likely to have exercised.
	series, ok := data["series"].([]any)
	if !ok {
		t.Fatalf("series is %T, want an empty array", data["series"])
	}
	if len(series) != 0 {
		t.Fatalf("series has %d points, want 0", len(series))
	}
}

func TestBreakdownGroupsByAxisDearestFirst(t *testing.T) {
	a := serve(t)
	a.seedRollup(rollup{bucketAgo: time.Hour, product: "kora", provider: "vertex", model: "gemini-2.5-pro",
		requests: 5, cost: 1, input: 100, output: 10})
	a.seedRollup(rollup{bucketAgo: time.Hour, product: "devai", provider: "anthropic", model: "claude-sonnet-4-5",
		requests: 2, cost: 9, input: 200, output: 20})

	data := a.data(a.get("/v1/ai/usage/breakdown?by=provider&window=24h"))
	if data["by"] != "provider" {
		t.Fatalf("by = %v, want provider", data["by"])
	}
	rows := data["rows"].([]any)
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if first := rows[0].(map[string]any); first["key"] != "anthropic" {
		t.Fatalf("dearest row is %v, want anthropic", first["key"])
	}
}

func TestBreakdownNarrowsByProduct(t *testing.T) {
	a := serve(t)
	a.seedRollup(rollup{bucketAgo: time.Hour, product: "kora", provider: "vertex", model: "m", requests: 5, cost: 1})
	a.seedRollup(rollup{bucketAgo: time.Hour, product: "devai", provider: "anthropic", model: "m", requests: 2, cost: 9})

	data := a.data(a.get("/v1/ai/usage/breakdown?by=provider&product=kora"))
	rows := data["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if key := rows[0].(map[string]any)["key"]; key != "vertex" {
		t.Fatalf("row key = %v, want vertex", key)
	}
}

func TestBreakdownRejectsAnUnknownAxis(t *testing.T) {
	a := serve(t)
	rec := a.get("/v1/ai/usage/breakdown?by=tenant")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
}

func TestGuardrailsReportRulesAndRefusals(t *testing.T) {
	a := serve(t)
	a.seedRollup(rollup{bucketAgo: time.Hour, product: "kora", provider: "vertex", model: "m",
		requests: 10, ok: 7, blocked: 2, rateLimited: 1, masked: 3})
	a.seedEvent(event{spanID: "s1", ago: time.Minute, product: "kora", provider: "vertex", model: "m",
		outcome: "guardrail_blocked", action: "reject", rule: "CreditCard", statusCode: 400})
	a.seedEvent(event{spanID: "s2", ago: 2 * time.Minute, product: "kora", provider: "vertex", model: "m",
		outcome: "guardrail_blocked", action: "reject", rule: "CreditCard", statusCode: 400})
	a.seedEvent(event{spanID: "s3", ago: 3 * time.Minute, product: "kora", provider: "vertex", model: "m",
		outcome: "ok", action: "mask", rule: "Email"})

	data := a.data(a.get("/v1/ai/usage/guardrails?window=24h"))
	if got := number(t, data, "blocked_requests"); got != 2 {
		t.Fatalf("blocked = %v, want 2", got)
	}
	if got := number(t, data, "rate_limited_requests"); got != 1 {
		t.Fatalf("rate limited = %v, want 1", got)
	}

	rules := data["rules"].([]any)
	if len(rules) != 2 {
		t.Fatalf("rules = %d, want 2", len(rules))
	}
	top := rules[0].(map[string]any)
	if top["rule"] != "CreditCard" || top["requests"].(float64) != 2 {
		t.Fatalf("busiest rule = %v", top)
	}
	// A masked request is not a blocked one: the rule fired, the request still
	// reached a provider. Conflating them would overstate what the guardrails
	// refused.
	masked := rules[1].(map[string]any)
	if masked["action"] != "mask" {
		t.Fatalf("second rule = %v, want the mask", masked)
	}
}

func TestEventsAreNewestFirstAndCapped(t *testing.T) {
	a := serve(t)
	for i := range 3 {
		a.seedEvent(event{
			spanID: fmt.Sprintf("span-%d", i), ago: time.Duration(i) * time.Minute,
			product: "kora", provider: "vertex", model: "gemini-2.5-pro", outcome: "ok",
			input: int64(100 * (i + 1)), output: 10, cost: 0.01,
		})
	}

	data := a.data(a.get("/v1/ai/usage/events?limit=2"))
	events := data["events"].([]any)
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2", len(events))
	}
	if id := events[0].(map[string]any)["span_id"]; id != "span-0" {
		t.Fatalf("newest event = %v, want span-0", id)
	}
}

func TestEventsNarrowByOutcome(t *testing.T) {
	a := serve(t)
	a.seedEvent(event{spanID: "ok-1", ago: time.Minute, product: "kora", provider: "vertex", model: "m", outcome: "ok"})
	a.seedEvent(event{spanID: "limited-1", ago: 2 * time.Minute, product: "kora", provider: "vertex", model: "m",
		outcome: "rate_limited", statusCode: 429})

	data := a.data(a.get("/v1/ai/usage/events?outcome=rate_limited"))
	events := data["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if id := events[0].(map[string]any)["span_id"]; id != "limited-1" {
		t.Fatalf("event = %v, want limited-1", id)
	}
}

func TestEventsRejectAnOversizedLimit(t *testing.T) {
	a := serve(t)
	rec := a.get("/v1/ai/usage/events?limit=5000")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
}

func TestUnknownQueryParametersAreRefused(t *testing.T) {
	a := serve(t)
	// A silently ignored filter is a wrong answer with no way to tell it is
	// wrong — #307's finding, applied to this module's first request.
	rec := a.get("/v1/ai/usage/summary?tenant=acme")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestAnUnknownWindowIsRefused(t *testing.T) {
	a := serve(t)
	rec := a.get("/v1/ai/usage/summary?window=90d")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
}

func TestEveryRouteRequiresThePlatformCapability(t *testing.T) {
	a := serveAs(t, "read", "support")
	for _, path := range []string{
		"/v1/ai/usage/summary",
		"/v1/ai/usage/breakdown",
		"/v1/ai/usage/guardrails",
		"/v1/ai/usage/events",
	} {
		if rec := a.get(path); rec.Code != http.StatusForbidden {
			t.Fatalf("%s = %d, want 403", path, rec.Code)
		}
	}
}

func TestAnUnauthenticatedRequestIsRefused(t *testing.T) {
	a := serve(t)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/ai/usage/summary", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
