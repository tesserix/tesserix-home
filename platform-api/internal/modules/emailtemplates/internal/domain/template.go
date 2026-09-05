// Package domain holds the email templates module's wire types.
package domain

import "time"

// Variable is one declared interpolation a template takes.
//
// Carried through verbatim from the product. The vocabulary of `type` is the
// product's — mark8ly's editor writes whatever its own schema declares — and a
// translation table here would be a second vocabulary free to drift from the
// first, the argument tenants makes for its status strings.
type Variable struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

// Row is one template in the registry listing.
//
// # state and sends_from are two questions, not one
//
// They are orthogonal on purpose and both are carried. A DRAFT row and an
// ABSENT row are different things to an operator — one is work in progress,
// one has never been touched — and yet both send the embedded default, because
// the product's send path filters on `status = 'published'`. Collapsing them
// into a single status is how a console comes to show a saved draft as though
// it were live, which is the one mistake this surface exists to prevent.
type Row struct {
	// ID is `<source>:<key>`, namespaced the way the tenants and audit modules
	// namespace theirs: two products' registries can hold the same key — the
	// second source coming (mark8ly's platform-api, mark8ly#720) has MIRRORED
	// tables — so an un-namespaced key would collapse two different templates
	// into one row in a merged list, and any write keyed on it would be aimed
	// at whichever product answered last.
	ID string `json:"id"`
	// Source is the product that owns the row, stamped from the slug the call
	// was MADE to and never read from the body: a product must not be able to
	// name itself into another product's registry.
	Source string `json:"source"`
	// Key is the product's own key, unqualified, because that is what an
	// operator recognises and what the product's Go call sites use. Carried
	// beside ID rather than instead of it — reconstructing one from the other
	// in every consumer is how a split-on-the-wrong-colon bug gets written
	// twice.
	Key string `json:"key"`
	// State is `published`, `draft` or `unauthored`.
	State string `json:"state"`
	// SendsFrom is `row`, `embedded` or `nothing` — where a send would take
	// its copy from right now.
	SendsFrom string `json:"sends_from"`
	// HasEmbeddedDefault says whether a Go call site registered a fallback.
	// Without it, `sends_from: nothing` is unexplained.
	HasEmbeddedDefault bool `json:"has_embedded_default"`
	// Subject is the RAW template source, not an interpolated line, so it
	// carries no customer detail.
	Subject string `json:"subject"`
	// Version, UpdatedAt and UpdatedBy are ABSENT for an unauthored key rather
	// than zeroed: a version of 0 beside a template that is sending perfectly
	// well reads as a broken row.
	Version *int `json:"version,omitempty"`
	// A real time.Time rather than the product's string, so an unparseable
	// timestamp is a decode failure here instead of an "Invalid Date" in a
	// browser. Serialised RFC 3339, which is what it arrived as.
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
	// UpdatedBy is the OPERATOR who last saved, stamped by the product from
	// the signed caller. An operator subject, not a merchant's identifier —
	// the same attribution the audit module publishes as `actor`, and the
	// reason §2's "no third-party identifiers" does not reach it.
	UpdatedBy *string `json:"updated_by,omitempty"`
}

// Detail is the single-template read: the row plus the bodies and the declared
// variables.
//
// For an unauthored key the bodies are the product's EMBEDDED default, not
// empty strings — that is what is sending right now, so it is what an editor
// must open with.
type Detail struct {
	Row
	HTMLBody string `json:"html_body"`
	TextBody string `json:"text_body"`
	// Never nil on the wire: a console reading `variables.map(...)` crashes on
	// exactly the templates that declare none.
	Variables []Variable `json:"variables"`
}

// Failure is one source that could not be read.
//
// Deliberately not federation.Failure: `source`/`message` is what every other
// console surface in this service already renders, and the mapping belongs in
// the module that owns the wire format rather than in the kernel. It carries
// no cause — that goes to the log, unredacted.
type Failure struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

// Page is the listing: what was read, and what could not be.
type Page struct {
	// Never nil. A client typing this as an array meets a type error on the
	// response it is least likely to have exercised.
	Templates []Row `json:"templates"`
	// Never nil either, and non-empty is the ONLY thing that distinguishes a
	// partial listing from a complete one. A failed federated read otherwise
	// looks exactly like a registry with nothing in it.
	Failures []Failure `json:"failures"`
}

// TestSend is what a test send reports it did.
//
// `sent` is stated rather than implied by the status code, because the console
// renders a sentence naming the address and must not have to infer it.
type TestSend struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Key    string `json:"key"`
	To     string `json:"to"`
	Sent   bool   `json:"sent"`
}
