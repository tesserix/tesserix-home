package ingest_test

import (
	"os"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/ingest"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
	collectorpb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestGatewayDecisionExportReachesPricedLedgerOnce(t *testing.T) {
	// Captured from agentgateway v1.4.1 against a synthetic TypeSafe response.
	raw, err := os.ReadFile("testdata/gateway-decision.json")
	if err != nil {
		t.Fatal(err)
	}
	var export collectorpb.ExportTraceServiceRequest
	if err := protojson.Unmarshal(raw, &export); err != nil {
		t.Fatal(err)
	}
	records := ingest.FromTraces(export.ResourceSpans)
	if len(records) != 1 {
		t.Fatalf("got %d records", len(records))
	}
	r := records[0]
	if r.UserID != "synthetic-probe-user" || r.ServiceName != "kora-api" || r.InputTokens != 123 || r.OutputTokens != 45 {
		t.Fatalf("lost gateway evidence: %+v", r)
	}
	pool := testdb.New(t)
	writer := ingest.NewWriter(pool)
	for i := 0; i < 2; i++ {
		stored, err := writer.Write(t.Context(), r)
		if err != nil {
			t.Fatal(err)
		}
		if stored != (i == 0) {
			t.Fatalf("replay stored=%v", stored)
		}
	}
	got := readEvent(t, pool, r.SpanID)
	if got.costSource != "partial" || got.cost != 0.000005166 {
		t.Fatalf("known input cost=%v source=%s", got.cost, got.costSource)
	}
	var requests int
	if err := pool.QueryRow(t.Context(), `SELECT SUM(requests) FROM ai_usage_hourly`).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("replay double-counted: %d", requests)
	}
}
