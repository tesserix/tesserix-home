// Package ingest is the AI usage module's write side: it turns agentgateway's
// OTLP spans into ledger rows.
//
// It is a separate binary from the API (cmd/ai-usage-ingest) because the two
// fail differently — a gateway that cannot export telemetry must not be able to
// take the console's reads down — but it lives inside the module because the
// ledger's shape is the module's, and a second package owning half of it is how
// the two drift apart.
package ingest

import "time"

// Record is one LLM request, in the shape ai_usage_events stores.
//
// Deliberately not the read side's domain.Event: that type carries what the
// console renders, this one carries what the table constrains, and folding them
// together would mean every column change touched the API's JSON.
type Record struct {
	SpanID     string
	TraceID    string
	OccurredAt time.Time

	Gateway    string
	Product    string
	Capability string

	Provider      string
	RequestModel  string
	ResponseModel string

	InputTokens  int64
	OutputTokens int64
	// Counted inside InputTokens, per gen_ai semantic conventions.
	CachedInputTokens int64

	// Zero with CostSource "unpriced" means nobody could price it — not free.
	CostUSD    float64
	CostSource string

	StatusCode      int
	Outcome         string
	GuardrailAction string
	GuardrailRule   string

	// Negative means the span carried no usable duration.
	LatencyMS int
}

// Cost sources, mirroring the table's CHECK constraint.
const (
	CostFromGateway = "gateway"
	CostFromCatalog = "catalog"
	CostUnpriced    = "unpriced"
)

// Outcomes, mirroring the table's CHECK constraint.
const (
	OutcomeOK               = "ok"
	OutcomeGuardrailBlocked = "guardrail_blocked"
	OutcomeRateLimited      = "rate_limited"
	OutcomeProviderError    = "provider_error"
	OutcomeGatewayError     = "gateway_error"
)

// Guardrail actions, mirroring the table's CHECK constraint.
const (
	GuardrailReject = "reject"
	GuardrailMask   = "mask"
)
