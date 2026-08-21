package ingest_test

import (
	"testing"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/ingest"
)

func str(value string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}
}

func i64(value int64) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: value}}
}

func f64(value float64) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: value}}
}

func attrs(pairs map[string]*commonpb.AnyValue) []*commonpb.KeyValue {
	out := make([]*commonpb.KeyValue, 0, len(pairs))
	for key, value := range pairs {
		out = append(out, &commonpb.KeyValue{Key: key, Value: value})
	}
	return out
}

func span(t *testing.T, pairs map[string]*commonpb.AnyValue) *tracepb.Span {
	t.Helper()
	return &tracepb.Span{
		SpanId:            []byte{1, 2, 3, 4, 5, 6, 7, 8},
		TraceId:           []byte{9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9},
		StartTimeUnixNano: uint64(time.Date(2026, 8, 20, 6, 59, 12, 0, time.UTC).UnixNano()),
		EndTimeUnixNano:   uint64(time.Date(2026, 8, 20, 6, 59, 13, 0, time.UTC).UnixNano()),
		Attributes:        attrs(pairs),
	}
}

func export(service string, spans ...*tracepb.Span) []*tracepb.ResourceSpans {
	return []*tracepb.ResourceSpans{{
		Resource: &resourcepb.Resource{Attributes: attrs(map[string]*commonpb.AnyValue{
			"service.name": str(service),
		})},
		ScopeSpans: []*tracepb.ScopeSpans{{Spans: spans}},
	}}
}

func llm(extra map[string]*commonpb.AnyValue) map[string]*commonpb.AnyValue {
	pairs := map[string]*commonpb.AnyValue{
		"gen_ai.system":              str("anthropic"),
		"gen_ai.request.model":       str("claude-opus-5"),
		"gen_ai.usage.input_tokens":  i64(1200),
		"gen_ai.usage.output_tokens": i64(340),
		"http.response.status_code":  i64(200),
		"tesserix.product":           str("marketplace"),
		"tesserix.capability":        str("listing-copy"),
	}
	for key, value := range extra {
		pairs[key] = value
	}
	return pairs
}

func TestFromTracesReadsOneLLMSpan(t *testing.T) {
	t.Parallel()

	records := ingest.FromTraces(export("agentgateway", span(t, llm(map[string]*commonpb.AnyValue{
		"gen_ai.response.model":                str("claude-opus-5-20260101"),
		"gen_ai.usage.cache_read_input_tokens": i64(900),
		"agw.ai.usage.cost.total":              f64(0.0184),
	}))))

	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	got := records[0]

	if got.SpanID != "0102030405060708" {
		t.Errorf("span id = %q", got.SpanID)
	}
	if got.TraceID == "" {
		t.Error("want the trace id carried through, for joining to the gateway's own traces")
	}
	if !got.OccurredAt.Equal(time.Date(2026, 8, 20, 6, 59, 12, 0, time.UTC)) {
		t.Errorf("occurred at = %s", got.OccurredAt)
	}
	if got.Gateway != "agentgateway" {
		t.Errorf("gateway = %q, want the resource's service name when no attribute overrides it", got.Gateway)
	}
	if got.Product != "marketplace" || got.Capability != "listing-copy" {
		t.Errorf("attribution = %q/%q", got.Product, got.Capability)
	}
	if got.Provider != "anthropic" || got.RequestModel != "claude-opus-5" {
		t.Errorf("provider/model = %q/%q", got.Provider, got.RequestModel)
	}
	if got.ResponseModel != "claude-opus-5-20260101" {
		t.Errorf("response model = %q", got.ResponseModel)
	}
	if got.InputTokens != 1200 || got.OutputTokens != 340 || got.CachedInputTokens != 900 {
		t.Errorf("tokens = %d/%d/%d", got.InputTokens, got.OutputTokens, got.CachedInputTokens)
	}
	if got.CostUSD != 0.0184 || got.CostSource != ingest.CostFromGateway {
		t.Errorf("cost = %v (%s), want the gateway's own figure preferred", got.CostUSD, got.CostSource)
	}
	if got.Outcome != ingest.OutcomeOK {
		t.Errorf("outcome = %q", got.Outcome)
	}
	if got.LatencyMS != 1000 {
		t.Errorf("latency = %d ms", got.LatencyMS)
	}
}

func TestFromTracesLeavesAnUnpricedSpanForTheCatalog(t *testing.T) {
	t.Parallel()

	records := ingest.FromTraces(export("agentgateway", span(t, llm(nil))))

	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	// Zero and "unpriced", not zero and "gateway": the difference is between a
	// call that was free and one nobody has priced yet.
	if records[0].CostSource != ingest.CostUnpriced || records[0].CostUSD != 0 {
		t.Errorf("cost = %v (%s)", records[0].CostUSD, records[0].CostSource)
	}
}

func TestFromTracesDropsSpansThatAreNotModelCalls(t *testing.T) {
	t.Parallel()

	// The gateway exports every proxied request. Storing this one would report
	// a cost of zero across a denominator full of health checks.
	health := span(t, map[string]*commonpb.AnyValue{
		"http.response.status_code": i64(200),
		"http.route":                str("/healthz"),
	})

	if records := ingest.FromTraces(export("agentgateway", health)); len(records) != 0 {
		t.Fatalf("want no records, got %d", len(records))
	}
}

func TestFromTracesDropsASpanWithNoID(t *testing.T) {
	t.Parallel()

	unkeyed := span(t, llm(nil))
	unkeyed.SpanId = nil

	if records := ingest.FromTraces(export("agentgateway", unkeyed)); len(records) != 0 {
		t.Fatalf("a span that cannot be deduplicated must not enter the ledger, got %d", len(records))
	}
}

func TestFromTracesReadsCELSerialisedNumbers(t *testing.T) {
	t.Parallel()

	// A CEL-computed tracing attribute arrives as a string even when it names a
	// count. Reading it as zero would silently under-report every request.
	records := ingest.FromTraces(export("agentgateway", span(t, llm(map[string]*commonpb.AnyValue{
		"gen_ai.usage.input_tokens":  str("1200"),
		"gen_ai.usage.output_tokens": str("340"),
		"agw.ai.usage.cost.total":    str("0.0184"),
		"http.response.status_code":  str("200"),
	}))))

	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	got := records[0]
	if got.InputTokens != 1200 || got.OutputTokens != 340 {
		t.Errorf("tokens = %d/%d", got.InputTokens, got.OutputTokens)
	}
	if got.CostUSD != 0.0184 || got.CostSource != ingest.CostFromGateway {
		t.Errorf("cost = %v (%s)", got.CostUSD, got.CostSource)
	}
	if got.StatusCode != 200 || got.Outcome != ingest.OutcomeOK {
		t.Errorf("status = %d (%s)", got.StatusCode, got.Outcome)
	}
}

func TestFromTracesFallsBackToTheLegacyStatusAttribute(t *testing.T) {
	t.Parallel()

	pairs := llm(nil)
	delete(pairs, "http.response.status_code")
	pairs["http.status_code"] = i64(429)

	records := ingest.FromTraces(export("agentgateway", span(t, pairs)))
	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	if records[0].Outcome != ingest.OutcomeRateLimited {
		t.Errorf("outcome = %q", records[0].Outcome)
	}
}

func TestFromTracesClampsCachedTokensToTheInputCount(t *testing.T) {
	t.Parallel()

	records := ingest.FromTraces(export("agentgateway", span(t, llm(map[string]*commonpb.AnyValue{
		"gen_ai.usage.input_tokens":            i64(100),
		"gen_ai.usage.cache_read_input_tokens": i64(400),
	}))))

	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	if records[0].CachedInputTokens != 100 {
		t.Errorf("cached = %d, want it clamped to the input count", records[0].CachedInputTokens)
	}
}

func TestFromTracesReadsTheOutcome(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		status    int64
		guardrail string
		want      string
		wantRule  string
	}{
		{name: "a served request", status: 200, want: ingest.OutcomeOK},
		{name: "a rejected prompt", status: 403, guardrail: ingest.GuardrailReject, want: ingest.OutcomeGuardrailBlocked, wantRule: "pii"},
		{
			// A masked request still reached the provider and still cost money.
			name: "a masked prompt", status: 200, guardrail: ingest.GuardrailMask,
			want: ingest.OutcomeOK, wantRule: "pii",
		},
		{name: "a throttled request", status: 429, want: ingest.OutcomeRateLimited},
		{name: "the provider failing behind the gateway", status: 503, want: ingest.OutcomeProviderError},
		{name: "the gateway refusing", status: 401, want: ingest.OutcomeGatewayError},
		{name: "the gateway breaking", status: 500, want: ingest.OutcomeGatewayError},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			pairs := llm(map[string]*commonpb.AnyValue{"http.response.status_code": i64(tc.status)})
			if tc.guardrail != "" {
				pairs["agw.guardrail.action"] = str(tc.guardrail)
				pairs["agw.guardrail.rule"] = str("pii")
			}

			records := ingest.FromTraces(export("agentgateway", span(t, pairs)))
			if len(records) != 1 {
				t.Fatalf("want 1 record, got %d", len(records))
			}
			if records[0].Outcome != tc.want {
				t.Errorf("outcome = %q, want %q", records[0].Outcome, tc.want)
			}
			if records[0].GuardrailRule != tc.wantRule {
				t.Errorf("rule = %q, want %q", records[0].GuardrailRule, tc.wantRule)
			}
		})
	}
}

func TestFromTracesRefusesAGuardrailVocabularyTheLedgerWouldReject(t *testing.T) {
	t.Parallel()

	// The column has a CHECK constraint; an unknown label would fail the whole
	// batch, and a missing label costs one row's detail.
	records := ingest.FromTraces(export("agentgateway", span(t, llm(map[string]*commonpb.AnyValue{
		"agw.guardrail.action": str("quarantine"),
	}))))

	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	if records[0].GuardrailAction != "" {
		t.Errorf("guardrail action = %q, want it dropped", records[0].GuardrailAction)
	}
}

func TestFromTracesPrefersTheExplicitGatewayAttribute(t *testing.T) {
	t.Parallel()

	records := ingest.FromTraces(export("otel-collector", span(t, llm(map[string]*commonpb.AnyValue{
		"tesserix.gateway": str("ai-gateway-prod"),
	}))))

	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	if records[0].Gateway != "ai-gateway-prod" {
		t.Errorf("gateway = %q", records[0].Gateway)
	}
}

func TestFromTracesReportsAnUnusableDurationAsUnknown(t *testing.T) {
	t.Parallel()

	// Zero, not "instant": a span whose end never arrived did not take no time.
	truncated := span(t, llm(nil))
	truncated.EndTimeUnixNano = 0

	records := ingest.FromTraces(export("agentgateway", truncated))
	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	if records[0].LatencyMS >= 0 {
		t.Errorf("latency = %d, want it negative to mean unknown", records[0].LatencyMS)
	}
}

func TestFromTracesReadsEverySpanInTheExport(t *testing.T) {
	t.Parallel()

	first := span(t, llm(nil))
	second := span(t, llm(nil))
	second.SpanId = []byte{8, 7, 6, 5, 4, 3, 2, 1}

	records := ingest.FromTraces(export("agentgateway", first, second))
	if len(records) != 2 {
		t.Fatalf("want 2 records, got %d", len(records))
	}
	if records[0].SpanID == records[1].SpanID {
		t.Error("want each span kept distinct")
	}
}

func TestFromTracesHandlesAnEmptyExport(t *testing.T) {
	t.Parallel()

	if records := ingest.FromTraces(nil); len(records) != 0 {
		t.Fatalf("want no records, got %d", len(records))
	}
}

// agentgateway emits the current OTel name; gen_ai.system is the legacy one.
func TestFromTracesReadsTheCurrentProviderAttribute(t *testing.T) {
	t.Parallel()

	pairs := llm(nil)
	delete(pairs, "gen_ai.system")
	pairs["gen_ai.provider.name"] = str("gcp.vertex_ai")

	records := ingest.FromTraces(export("kora-ai", span(t, pairs)))

	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	if records[0].Provider != "gcp.vertex_ai" {
		t.Errorf("provider = %q, want the gen_ai.provider.name value", records[0].Provider)
	}
}

func TestFromTracesPrefersTheCurrentProviderAttribute(t *testing.T) {
	t.Parallel()

	records := ingest.FromTraces(export("kora-ai", span(t, llm(map[string]*commonpb.AnyValue{
		"gen_ai.provider.name": str("gcp.vertex_ai"),
	}))))

	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	if records[0].Provider != "gcp.vertex_ai" {
		t.Errorf("provider = %q, want the current name to win over gen_ai.system", records[0].Provider)
	}
}
