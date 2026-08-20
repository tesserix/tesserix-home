package ingest

import (
	"encoding/hex"
	"strconv"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

// The attribute contract with agentgateway.
//
// `gen_ai.*` and `http.*` are OpenTelemetry semantic conventions the gateway
// emits on its own. `agw.*` are agentgateway's own cost attributes. `tesserix.*`
// are ours, added by the AgentgatewayPolicy's tracing attributes — the gateway
// has no idea which product a key belongs to until we tell it, and a
// client-supplied header cannot be trusted with that answer.
const (
	attrProduct    = "tesserix.product"
	attrCapability = "tesserix.capability"
	attrGateway    = "tesserix.gateway"

	attrProvider      = "gen_ai.system"
	attrRequestModel  = "gen_ai.request.model"
	attrResponseModel = "gen_ai.response.model"
	attrInputTokens   = "gen_ai.usage.input_tokens"
	attrOutputTokens  = "gen_ai.usage.output_tokens"
	attrCachedTokens  = "gen_ai.usage.cache_read_input_tokens"

	attrCostTotal = "agw.ai.usage.cost.total"

	attrGuardrailAction = "agw.guardrail.action"
	attrGuardrailRule   = "agw.guardrail.rule"

	attrStatusCode       = "http.response.status_code"
	attrLegacyStatusCode = "http.status_code"

	attrServiceName = "service.name"
)

// FromTraces converts an OTLP export into ledger records.
//
// Spans that are not LLM calls are dropped rather than stored with empty
// columns: the gateway exports every proxied request, and a ledger that counted
// health checks as unpriced model calls would report a cost of zero across a
// growing denominator.
func FromTraces(spans []*tracepb.ResourceSpans) []Record {
	records := make([]Record, 0, len(spans))
	for _, resource := range spans {
		service := stringAttr(resource.GetResource().GetAttributes(), attrServiceName)
		for _, scope := range resource.GetScopeSpans() {
			for _, span := range scope.GetSpans() {
				record, ok := fromSpan(span, service)
				if ok {
					records = append(records, record)
				}
			}
		}
	}
	return records
}

func fromSpan(span *tracepb.Span, service string) (Record, bool) {
	attrs := span.GetAttributes()
	model := stringAttr(attrs, attrRequestModel)
	provider := stringAttr(attrs, attrProvider)
	if model == "" && provider == "" {
		return Record{}, false
	}
	// A span with no id cannot be deduplicated, and the ledger's whole replay
	// story rests on that key.
	spanID := hex.EncodeToString(span.GetSpanId())
	if spanID == "" {
		return Record{}, false
	}

	status := intAttr(attrs, attrStatusCode)
	if status == 0 {
		status = intAttr(attrs, attrLegacyStatusCode)
	}
	action := guardrailAction(stringAttr(attrs, attrGuardrailAction))

	record := Record{
		SpanID:     spanID,
		TraceID:    hex.EncodeToString(span.GetTraceId()),
		OccurredAt: time.Unix(0, int64(span.GetStartTimeUnixNano())).UTC(),

		Gateway:    firstNonEmpty(stringAttr(attrs, attrGateway), service),
		Product:    stringAttr(attrs, attrProduct),
		Capability: stringAttr(attrs, attrCapability),

		Provider:      provider,
		RequestModel:  model,
		ResponseModel: stringAttr(attrs, attrResponseModel),

		InputTokens:       intAttr(attrs, attrInputTokens),
		OutputTokens:      intAttr(attrs, attrOutputTokens),
		CachedInputTokens: intAttr(attrs, attrCachedTokens),

		StatusCode:      int(status),
		Outcome:         outcomeFor(int(status), action),
		GuardrailAction: action,
		GuardrailRule:   stringAttr(attrs, attrGuardrailRule),

		LatencyMS: latency(span),
	}

	// A cached count larger than the input count would break the table's
	// "cached is a subset" contract; the honest reading of an inconsistent
	// pair is that the cache figure is the unreliable one.
	if record.CachedInputTokens > record.InputTokens {
		record.CachedInputTokens = record.InputTokens
	}

	if cost, ok := floatAttr(attrs, attrCostTotal); ok {
		record.CostUSD = cost
		record.CostSource = CostFromGateway
	} else {
		// Left for the writer to price from the catalog; it is the only place
		// that can, because the rate card lives in the database.
		record.CostSource = CostUnpriced
	}

	return record, true
}

// outcomeFor reads how the request ended.
//
// A masked request still reached a provider and still cost money, so only
// `reject` makes an outcome. 502/503/504 are the provider failing behind the
// gateway; every other 5xx and every non-429 4xx is the gateway's own refusal.
func outcomeFor(status int, guardrailAction string) string {
	switch {
	case guardrailAction == GuardrailReject:
		return OutcomeGuardrailBlocked
	case status == 429:
		return OutcomeRateLimited
	case status == 502, status == 503, status == 504:
		return OutcomeProviderError
	case status >= 400:
		return OutcomeGatewayError
	default:
		return OutcomeOK
	}
}

func guardrailAction(raw string) string {
	switch raw {
	case GuardrailReject, GuardrailMask:
		return raw
	default:
		// Anything else is a vocabulary the table would refuse anyway, and a
		// rejected batch is worse than a missing label.
		return ""
	}
}

func latency(span *tracepb.Span) int {
	start, end := span.GetStartTimeUnixNano(), span.GetEndTimeUnixNano()
	if end <= start {
		return -1
	}
	return int((end - start) / uint64(time.Millisecond))
}

func attr(attrs []*commonpb.KeyValue, key string) *commonpb.AnyValue {
	for _, kv := range attrs {
		if kv.GetKey() == key {
			return kv.GetValue()
		}
	}
	return nil
}

func stringAttr(attrs []*commonpb.KeyValue, key string) string {
	return attr(attrs, key).GetStringValue()
}

// intAttr reads a count that the gateway may have serialised either way: OTLP
// carries a native int, but a CEL-computed attribute arrives as a string.
func intAttr(attrs []*commonpb.KeyValue, key string) int64 {
	value := attr(attrs, key)
	switch {
	case value == nil:
		return 0
	case value.GetIntValue() != 0:
		return value.GetIntValue()
	case value.GetDoubleValue() != 0:
		return int64(value.GetDoubleValue())
	case value.GetStringValue() != "":
		n, err := strconv.ParseInt(value.GetStringValue(), 10, 64)
		if err != nil || n < 0 {
			return 0
		}
		return n
	default:
		return 0
	}
}

func floatAttr(attrs []*commonpb.KeyValue, key string) (float64, bool) {
	value := attr(attrs, key)
	switch {
	case value == nil:
		return 0, false
	case value.GetDoubleValue() != 0:
		return value.GetDoubleValue(), true
	case value.GetIntValue() != 0:
		return float64(value.GetIntValue()), true
	case value.GetStringValue() != "":
		f, err := strconv.ParseFloat(value.GetStringValue(), 64)
		if err != nil || f < 0 {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
