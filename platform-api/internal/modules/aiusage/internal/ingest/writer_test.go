package ingest_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/ingest"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// A real Postgres, not a mocked pool. Everything worth asserting about the
// writer — ON CONFLICT DO NOTHING, the effective-dated price lookup, the
// numeric rounding of a sub-cent cost — lives in the database, and a mock would
// only replay this file's own assumptions back at it.

var ran = time.Date(2026, 8, 20, 6, 59, 12, 0, time.UTC)

func record(mutate func(*ingest.Record)) ingest.Record {
	r := ingest.Record{
		SpanID:            "0102030405060708",
		TraceID:           "99999999999999999999999999999999",
		OccurredAt:        ran,
		Gateway:           "ai-gateway-prod",
		Product:           "marketplace",
		Capability:        "listing-copy",
		Provider:          "anthropic",
		RequestModel:      "claude-opus-5",
		ResponseModel:     "claude-opus-5-20260101",
		InputTokens:       1200,
		OutputTokens:      340,
		CachedInputTokens: 900,
		CostUSD:           0.0184,
		CostSource:        ingest.CostFromGateway,
		StatusCode:        200,
		Outcome:           ingest.OutcomeOK,
		LatencyMS:         1000,
	}
	if mutate != nil {
		mutate(&r)
	}
	return r
}

func priceCatalog(t *testing.T, pool *pgxpool.Pool, effectiveFrom time.Time, input, output, cached float64) {
	t.Helper()
	for kind, rate := range map[string]float64{"input": input, "output": output, "cached_input": cached} {
		if rate < 0 {
			continue
		}
		_, err := pool.Exec(context.Background(), `
			INSERT INTO ai_model_prices (provider, model, token_kind, usd_per_million, effective_from)
			VALUES ($1, $2, $3, $4, $5)`,
			"anthropic", "claude-opus-5-20260101", kind, rate, effectiveFrom)
		if err != nil {
			t.Fatalf("seeding %s price: %v", kind, err)
		}
	}
}

type storedEvent struct {
	cost       float64
	costSource string
	capability *string
	guardrail  *string
	latency    *int
}

func readEvent(t *testing.T, pool *pgxpool.Pool, spanID string) storedEvent {
	t.Helper()
	var got storedEvent
	err := pool.QueryRow(context.Background(), `
		SELECT cost_usd, cost_source, capability, guardrail_action, latency_ms
		FROM ai_usage_events WHERE span_id = $1`, spanID,
	).Scan(&got.cost, &got.costSource, &got.capability, &got.guardrail, &got.latency)
	if err != nil {
		t.Fatalf("reading the event: %v", err)
	}
	return got
}

func TestWriteStoresTheEventAndItsHour(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	stored, err := ingest.NewWriter(pool).Write(ctx, record(nil))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if !stored {
		t.Error("want the first write reported as new")
	}

	got := readEvent(t, pool, "0102030405060708")
	if got.cost != 0.0184 || got.costSource != ingest.CostFromGateway {
		t.Errorf("cost = %v (%s)", got.cost, got.costSource)
	}
	if got.capability == nil || *got.capability != "listing-copy" {
		t.Errorf("capability = %v", got.capability)
	}
	if got.latency == nil || *got.latency != 1000 {
		t.Errorf("latency = %v", got.latency)
	}

	var requests, inputTokens int64
	var bucket time.Time
	err = pool.QueryRow(ctx, `
		SELECT bucket, requests, input_tokens FROM ai_usage_hourly`,
	).Scan(&bucket, &requests, &inputTokens)
	if err != nil {
		t.Fatalf("reading the rollup: %v", err)
	}
	if requests != 1 || inputTokens != 1200 {
		t.Errorf("rollup = %d requests, %d input tokens", requests, inputTokens)
	}
	if !bucket.UTC().Equal(ran.Truncate(time.Hour)) {
		t.Errorf("bucket = %s, want the request's own hour", bucket.UTC())
	}
}

func TestWriteIsIdempotentUnderReplay(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	writer := ingest.NewWriter(pool)

	// The whole point of at-least-once delivery: a redelivered message must not
	// become a second row, and above all must not increment the bill.
	for range 3 {
		if _, err := writer.Write(ctx, record(nil)); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}

	stored, err := writer.Write(ctx, record(nil))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if stored {
		t.Error("want a replay reported as already recorded")
	}

	var events, requests int64
	var cost float64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_usage_events`).Scan(&events); err != nil {
		t.Fatalf("counting events: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT requests, cost_usd FROM ai_usage_hourly`).Scan(&requests, &cost); err != nil {
		t.Fatalf("reading the rollup: %v", err)
	}
	if events != 1 || requests != 1 {
		t.Errorf("%d events, %d rolled up requests, want 1 of each", events, requests)
	}
	if cost != 0.0184 {
		t.Errorf("cost = %v, want the single request's own cost", cost)
	}
}

func TestWriteAccumulatesTheHourAcrossRequests(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	writer := ingest.NewWriter(pool)

	second := record(func(r *ingest.Record) {
		r.SpanID = "0807060504030201"
		r.OccurredAt = ran.Add(-20 * time.Minute)
		r.InputTokens = 800
		r.OutputTokens = 100
		r.CostUSD = 0.01
	})
	for _, r := range []ingest.Record{record(nil), second} {
		if _, err := writer.Write(ctx, r); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}

	var buckets, requests, inputTokens int64
	var cost float64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_usage_hourly`).Scan(&buckets); err != nil {
		t.Fatalf("counting buckets: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT requests, input_tokens, cost_usd FROM ai_usage_hourly`,
	).Scan(&requests, &inputTokens, &cost); err != nil {
		t.Fatalf("reading the rollup: %v", err)
	}
	if buckets != 1 {
		t.Fatalf("%d buckets, want both requests folded into one hour", buckets)
	}
	if requests != 2 || inputTokens != 2000 {
		t.Errorf("rollup = %d requests, %d input tokens", requests, inputTokens)
	}
	if cost != 0.0284 {
		t.Errorf("cost = %v, want both costs summed", cost)
	}
}

func TestWriteSeparatesTheHoursAndTheProducts(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	writer := ingest.NewWriter(pool)

	nextHour := record(func(r *ingest.Record) {
		r.SpanID = "aaaa000000000001"
		r.OccurredAt = ran.Add(time.Hour)
	})
	otherProduct := record(func(r *ingest.Record) {
		r.SpanID = "aaaa000000000002"
		r.Product = "blog"
	})
	for _, r := range []ingest.Record{record(nil), nextHour, otherProduct} {
		if _, err := writer.Write(ctx, r); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}

	var buckets int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_usage_hourly`).Scan(&buckets); err != nil {
		t.Fatalf("counting buckets: %v", err)
	}
	if buckets != 3 {
		t.Errorf("%d buckets, want the hour and the product to each split the rollup", buckets)
	}
}

func TestWritePricesFromTheCatalogWhenTheGatewayDidNot(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	priceCatalog(t, pool, ran.Add(-24*time.Hour), 15, 75, 1.5)

	unpriced := record(func(r *ingest.Record) {
		r.CostUSD = 0
		r.CostSource = ingest.CostUnpriced
	})
	if _, err := ingest.NewWriter(pool).Write(ctx, unpriced); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// 300 uncached input at $15/M, 900 cached at $1.50/M, 340 output at $75/M.
	want := (300*15.0 + 900*1.5 + 340*75.0) / 1_000_000
	got := readEvent(t, pool, "0102030405060708")
	if got.costSource != ingest.CostFromCatalog {
		t.Errorf("cost source = %q", got.costSource)
	}
	if got.cost != want {
		t.Errorf("cost = %v, want %v", got.cost, want)
	}
}

func TestWritePricesAtTheRateInForceWhenTheRequestRan(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	// A replayed span must be priced at the card that was in force when it ran,
	// or replaying a week of the stream would silently restate history.
	priceCatalog(t, pool, ran.Add(-72*time.Hour), 15, 75, 1.5)
	priceCatalog(t, pool, ran.Add(72*time.Hour), 30, 150, 3)

	unpriced := record(func(r *ingest.Record) {
		r.CostUSD = 0
		r.CostSource = ingest.CostUnpriced
	})
	if _, err := ingest.NewWriter(pool).Write(ctx, unpriced); err != nil {
		t.Fatalf("Write: %v", err)
	}

	want := (300*15.0 + 900*1.5 + 340*75.0) / 1_000_000
	if got := readEvent(t, pool, "0102030405060708"); got.cost != want {
		t.Errorf("cost = %v, want the older rate card at %v", got.cost, want)
	}
}

func TestWriteBillsCachedTokensAtTheInputRateWhenTheCatalogHasNoCacheRate(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	priceCatalog(t, pool, ran.Add(-24*time.Hour), 15, 75, -1)

	unpriced := record(func(r *ingest.Record) {
		r.CostUSD = 0
		r.CostSource = ingest.CostUnpriced
	})
	if _, err := ingest.NewWriter(pool).Write(ctx, unpriced); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// No cache rate means no discount, not free.
	want := (1200*15.0 + 340*75.0) / 1_000_000
	if got := readEvent(t, pool, "0102030405060708"); got.cost != want {
		t.Errorf("cost = %v, want %v", got.cost, want)
	}
}

func TestWriteLeavesAnUnknownModelUnpriced(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	unpriced := record(func(r *ingest.Record) {
		r.CostUSD = 0
		r.CostSource = ingest.CostUnpriced
	})
	if _, err := ingest.NewWriter(pool).Write(ctx, unpriced); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Zero cost recorded as "unpriced", so the surface can render it as unknown
	// rather than as $0.00 — the difference between free and unmeasured.
	got := readEvent(t, pool, "0102030405060708")
	if got.costSource != ingest.CostUnpriced || got.cost != 0 {
		t.Errorf("cost = %v (%s)", got.cost, got.costSource)
	}
}

func TestWriteCountsTheOutcomesTheGuardrailsSurfaceReads(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	writer := ingest.NewWriter(pool)

	records := []ingest.Record{
		record(nil),
		record(func(r *ingest.Record) {
			r.SpanID = "bbbb000000000001"
			r.Outcome = ingest.OutcomeGuardrailBlocked
			r.GuardrailAction = ingest.GuardrailReject
			r.GuardrailRule = "pii"
			r.StatusCode = 403
		}),
		record(func(r *ingest.Record) {
			r.SpanID = "bbbb000000000002"
			r.Outcome = ingest.OutcomeRateLimited
			r.StatusCode = 429
		}),
		record(func(r *ingest.Record) {
			r.SpanID = "bbbb000000000003"
			r.Outcome = ingest.OutcomeProviderError
			r.StatusCode = 503
		}),
		record(func(r *ingest.Record) {
			// A masked request still reached the provider: ok, and counted as
			// masked.
			r.SpanID = "bbbb000000000004"
			r.GuardrailAction = ingest.GuardrailMask
			r.GuardrailRule = "pii"
		}),
	}
	for _, r := range records {
		if _, err := writer.Write(ctx, r); err != nil {
			t.Fatalf("Write %s: %v", r.SpanID, err)
		}
	}

	var ok, blocked, rateLimited, errored, masked int64
	err := pool.QueryRow(ctx, `
		SELECT sum(ok_requests), sum(blocked_requests), sum(rate_limited_requests),
		       sum(error_requests), sum(masked_requests)
		FROM ai_usage_hourly`,
	).Scan(&ok, &blocked, &rateLimited, &errored, &masked)
	if err != nil {
		t.Fatalf("reading the rollup: %v", err)
	}
	if ok != 2 || blocked != 1 || rateLimited != 1 || errored != 1 || masked != 1 {
		t.Errorf("counters = ok %d, blocked %d, limited %d, errors %d, masked %d",
			ok, blocked, rateLimited, errored, masked)
	}
}

func TestWriteStoresAnUnattributedRequestRatherThanDroppingIt(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	// A product the policy forgot to label is still spend. Dropping it would
	// make the total quietly wrong; NULL says "nobody said" rather than
	// inventing a capability named "".
	unlabelled := record(func(r *ingest.Record) {
		r.Product = ""
		r.Capability = ""
	})
	if _, err := ingest.NewWriter(pool).Write(ctx, unlabelled); err != nil {
		t.Fatalf("Write: %v", err)
	}

	if got := readEvent(t, pool, "0102030405060708"); got.capability != nil {
		t.Errorf("capability = %q, want NULL", *got.capability)
	}
}

func TestWriteRecordsAnUnknownLatencyAsNull(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	truncated := record(func(r *ingest.Record) { r.LatencyMS = -1 })
	if _, err := ingest.NewWriter(pool).Write(ctx, truncated); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// NULL, not zero: a span whose end never arrived did not take no time.
	if got := readEvent(t, pool, "0102030405060708"); got.latency != nil {
		t.Errorf("latency = %d, want NULL", *got.latency)
	}
}

func TestWriteRefusesARecordWithNoSpanID(t *testing.T) {
	pool := testdb.New(t)

	// The ledger's whole replay story rests on that key.
	stored, err := ingest.NewWriter(pool).Write(context.Background(),
		record(func(r *ingest.Record) { r.SpanID = "" }))
	if err == nil {
		t.Fatal("want an error")
	}
	if stored {
		t.Error("want nothing reported as stored")
	}
}
