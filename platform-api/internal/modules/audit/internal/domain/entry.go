// Package domain holds the audit module's types.
package domain

import (
	"time"
)

// Entry is one audit row, from any source.
//
// Field names and json tags match apps/console/lib/audit.ts's `parseEntry`
// exactly — that parser is the contract for this wire shape, not this file.
// A rename here without a matching change there is a runtime failure in the
// browser, not a compile error anywhere; TestPageMarshalsTheShapeTheConsole
// Parses in the service package pins the emitted key set for that reason.
type Entry struct {
	ID     string `json:"id"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	// Timestamp stays a real time.Time, not a string, so sorting by newest
	// first sorts on an actual instant. encoding/json renders it RFC 3339,
	// which is both a string on the wire (satisfying the console's `str()`
	// check) and ISO-8601 (the estate's convention).
	Timestamp time.Time `json:"timestamp"`
	// Source is REQUIRED on every row. "Who did what" without "where" is not a
	// whole answer, and the console renders this column.
	Source string `json:"source"`
	// Target replaces the old ResourceType/ResourceID pair: one optional
	// string, because that is what the console's parser reads.
	Target   string `json:"target,omitempty"`
	Metadata string `json:"metadata,omitempty"`
}

// Failure is one source that could not be read, in the shape the console
// renders.
//
// Deliberately not federation.Failure: that type is kernel vocabulary shared
// by every product contract, and `product`/`error` are its names. The console
// has read `source`/`message` since apps/web served this surface, so the
// mapping belongs here — in the module that owns this wire format — rather
// than in the kernel.
type Failure struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

// Page is the surface's response: what was read, and what could not be.
type Page struct {
	Entries  []Entry   `json:"entries"`
	Failures []Failure `json:"failures"`
}
