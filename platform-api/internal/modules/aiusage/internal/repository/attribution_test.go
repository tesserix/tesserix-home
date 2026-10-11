package repository_test

import (
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/ingest"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
	"testing"
	"time"
)

func TestAttributionIsQueryableWithoutMixingProducts(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	at := time.Now().UTC()
	for _, r := range []ingest.Record{
		{SpanID: "a", Product: "kora", UserID: "user-a", ServiceName: "kora-api", InputTokens: 100, CostUSD: 0.001},
		{SpanID: "b", Product: "kora", UserID: "user-b", ServiceName: "kora-ai-agents", InputTokens: 200, CostUSD: 0.002},
		{SpanID: "c", Product: "other", UserID: "user-a", ServiceName: "other-api", InputTokens: 300, CostUSD: 0.003},
	} {
		r.OccurredAt = at
		r.Gateway = "test"
		r.Provider = "test"
		r.RequestModel = "test"
		r.CostSource = ingest.CostFromGateway
		r.Outcome = ingest.OutcomeOK
		if _, err := ingest.NewWriter(pool).Write(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.New(pool)
	for _, axis := range []string{"user", "service"} {
		d, err := domain.ParseDimension(axis)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := repo.Breakdown(ctx, at.Add(-time.Hour), d, repository.Filter{Product: "kora"})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 2 || rows[0].Requests != 1 || rows[0].Tokens.Input != 200 || rows[0].CostUSD != 0.002 {
			t.Fatalf("%s breakdown: %+v", axis, rows)
		}
	}
	events, err := repo.Events(ctx, at.Add(-time.Hour), 10, repository.EventFilter{Filter: repository.Filter{Product: "kora"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].UserID == nil || *events[0].UserID != "user-b" || events[0].ServiceName == nil || *events[0].ServiceName != "kora-ai-agents" {
		t.Fatalf("events: %+v", events)
	}
}

func TestTotalsReportPricingGaps(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	at := time.Now().UTC()
	for _, source := range []string{"catalog", "partial", "unpriced"} {
		r := ingest.Record{SpanID: source, OccurredAt: at, Product: "kora", Gateway: "test", Provider: "test", RequestModel: "test", CostSource: source, Outcome: ingest.OutcomeOK}
		if _, err := ingest.NewWriter(pool).Write(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	totals, err := repository.New(pool).Totals(ctx, at.Add(-time.Hour), repository.Filter{Product: "kora"})
	if err != nil {
		t.Fatal(err)
	}
	if totals.UnpricedRequests != 1 || totals.PartialRequests != 1 {
		t.Fatalf("pricing gaps hidden: %+v", totals)
	}
}
