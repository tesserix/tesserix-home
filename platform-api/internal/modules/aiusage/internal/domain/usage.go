package domain

import "time"

// Tokens is one request's, or one bucket's, token accounting.
//
// Cached is a SUBSET of Input, matching the gen_ai semantic conventions the
// gateway emits. Summing Input + Output + Cached double-counts, which is
// exactly the mistake this comment exists to stop.
type Tokens struct {
	Input  int64
	Output int64
	Cached int64
}

// Totals is a window's aggregate.
type Totals struct {
	Requests    int64
	Tokens      Tokens
	CostUSD     float64
	OK          int64
	Blocked     int64
	RateLimited int64
	Errors      int64
	Masked      int64
}

// SeriesPoint is one bucket of the window.
type SeriesPoint struct {
	Bucket   time.Time
	Requests int64
	Tokens   Tokens
	CostUSD  float64
}

// BreakdownRow is one value of whichever axis was grouped by.
type BreakdownRow struct {
	// Key is the axis value. Empty for traffic the gateway could not attribute
	// — an uncategorised capability, most often — and returned as such rather
	// than dropped: unattributed spend is the spend worth seeing.
	Key      string
	Requests int64
	Tokens   Tokens
	CostUSD  float64
	Errors   int64
	Blocked  int64
}

// GuardrailRow is one prompt-guard or rate-limit rule's activity.
type GuardrailRow struct {
	Rule     string
	Action   string
	Product  string
	Requests int64
	LastSeen time.Time
}

// Event is one request as the gateway saw it.
type Event struct {
	SpanID          string
	TraceID         string
	OccurredAt      time.Time
	Gateway         string
	Product         string
	Capability      *string
	Provider        string
	RequestModel    string
	ResponseModel   *string
	Tokens          Tokens
	CostUSD         float64
	CostSource      string
	StatusCode      int
	Outcome         Outcome
	GuardrailAction *string
	GuardrailRule   *string
	LatencyMS       *int
}
