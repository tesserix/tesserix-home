// Package domain holds the outbox module's types.
package domain

// Event is one outbox_events row, from any source.
//
// Field names mirror mark8ly's pinned contract shape verbatim
// (services/marketplace-api/internal/handlers/platformadmin/outbox.go:79-90)
// — that struct is the wire contract for this shape, not this file, so a
// field renamed here without a matching change there is a silent decode
// mismatch rather than a compile error anywhere.
type Event struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenant_id"`
	Aggregate   string `json:"aggregate"`
	AggregateID string `json:"aggregate_id"`
	EventType   string `json:"event_type"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
	// AgeSeconds is ABSENT for a published row: it is settled and has no
	// waiting time. A number that grew forever there would read as "stuck"
	// beside a genuinely stuck row, so absence is preserved rather than
	// defaulted to zero.
	AgeSeconds *int64 `json:"age_seconds,omitempty"`
	// PublishedAt is present only once the event has gone out.
	PublishedAt *string `json:"published_at,omitempty"`
	// Error is OPAQUE. outbox_events.error has no CHECK constraint and the
	// operator requeue path is a raw UPDATE, so the values mark8ly writes
	// are not the only ones observable here. Never switch on it.
	Error *string `json:"error,omitempty"`
	// Source is REQUIRED on every row, and is stamped from the slug the call
	// was MADE to, never read from the body — the same rule the audit and
	// inbox modules apply. A merged list from two products whose rows are
	// indistinguishable is not a governance surface, and a product must not
	// be able to name itself into another product's rows.
	Source string `json:"source"`

	// There is deliberately no Payload field here. It is arbitrary JSONB
	// that may carry customer data, excluded by construction upstream
	// (toOutboxRow in outbox.go copies the source struct field by field, and
	// that struct has no payload either), and must stay excluded here.
}

// Failure is one source that could not be read, in the shape the console
// renders.
//
// Deliberately not federation.Failure: that type is kernel vocabulary shared
// by every product contract, and `product`/`error` are its names. The
// audit and inbox modules both map to `source`/`message` for the console,
// and this module keeps the same mapping for the same reason: it belongs to
// the module that owns this wire format, not to the kernel.
type Failure struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

// Page is the surface's response: what was read, what could not be, and
// which sources said outright that they have none.
type Page struct {
	Events   []Event   `json:"events"`
	Failures []Failure `json:"failures"`
	// NotImplemented is every product that DECLARED the outbox contract
	// endpoint but answered 501 for this particular request — a live
	// contract statement ("I have nothing to report here"), not a broken
	// source. Kept apart from Failures for the same reason the kpis module
	// keeps ErrNotInstrumented apart from a transport error: collapsing the
	// two would tell an operator a product's outbox is BROKEN when it has
	// simply said it has none, which is the more alarming of the two
	// mistakes to get wrong on a page operators use to judge estate health.
	NotImplemented []string `json:"not_implemented"`
}
