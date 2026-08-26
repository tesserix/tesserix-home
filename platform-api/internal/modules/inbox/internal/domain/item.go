// Package domain holds the inbox module's types.
package domain

import "time"

// Action is something an operator may do to an item, as the product declares
// it.
//
// Carried through verbatim and NOT invoked by this service. §8.3 defines
// `POST /admin/inbox/{id}/actions/{actionId}` and no product implements it
// yet — Kora deliberately returns an empty `actions` array, with the right
// reasoning: "§3.2 says to declare only actions the product can actually
// perform. A 'Resolve' button that 404s is a worse inbox than one with no
// buttons."
//
// So this type exists to render a declaration honestly today and to be the
// shape an execution path uses later, not to promise one now.
type Action struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Destructive drives confirmation in the console, and §8.3 additionally
	// requires an idempotency key when such an action is eventually invoked.
	Destructive bool `json:"destructive"`
}

// Item is one thing waiting on a human, from any product.
//
// The field set is §3.2's, and matches what Kora — the only implementer today
// — actually serves. Where the contract and a product disagree the contract
// wins, but there is no disagreement here.
type Item struct {
	ID string `json:"id"`
	// Source is REQUIRED on every item and is stamped from the slug the call
	// was MADE to, never read from the body. "Something is waiting" without
	// "where" is not a whole answer, and it is the column that lets one queue
	// carry several products without an operator having to guess.
	Source string `json:"source"`
	// Kind is the PRODUCT's vocabulary, rendered verbatim — Kora emits
	// `feedback` and `unresolved_food`. Not narrowed to a union here for the
	// same reason `EstateTenant.status` is not: a console-side enumeration is
	// a second vocabulary that drifts from the first, and an unknown kind
	// rendered as itself is honest where an unknown kind rendered as "Other"
	// is a small lie.
	Kind     string `json:"kind"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle,omitempty"`
	// WaitingSince is a real time.Time, not a string, so the merged queue
	// sorts on an actual instant rather than lexically. §4.3 requires ISO 8601
	// with an offset, which encoding/json parses and re-renders as RFC 3339.
	//
	// A product sending something else fails the decode for that product
	// only — it becomes a Failure, not a silently mis-sorted row.
	WaitingSince time.Time `json:"waiting_since"`
	// DueAt is present only where the product declared an SLA, which is why it
	// is a pointer: absent and "due now" must not collapse into each other.
	DueAt    *time.Time `json:"due_at,omitempty"`
	Severity string     `json:"severity,omitempty"`
	// Href is the product's own deep link, when it offers one. Left exactly as
	// the product sent it: this service does not know how to rewrite another
	// product's URLs, and a guessed rewrite is worse than an absent link.
	Href    string   `json:"href,omitempty"`
	Actions []Action `json:"actions"`
}

// Failure is one source that could not be read, in the shape the console
// renders.
//
// Deliberately not federation.Failure — that type is kernel vocabulary and its
// names are `product`/`error`. The console reads `source`/`message` on every
// other federated surface, so the mapping belongs in the module that owns this
// wire format, exactly as the audit module does it.
type Failure struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

// Page is the surface's response: what is waiting, how much of it there is,
// and what could not be read.
type Page struct {
	Items []Item `json:"items"`
	// Total is the sum of every answering product's own total, which is the
	// QUEUE DEPTH and may exceed len(Items) when a product was asked for a
	// bounded page.
	//
	// It deliberately counts only products that answered. Adding a failed
	// product's rows as zero would understate the estate's backlog while
	// looking like a complete count — `Failures` is what says the number is
	// partial, and the console must render both together.
	Total    int       `json:"total"`
	Failures []Failure `json:"failures"`
}
