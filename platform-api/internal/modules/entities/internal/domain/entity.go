// Package domain holds the entities module's types.
package domain

// Entity is one record from a product's §3.4 entity endpoint.
//
// Deliberately a SMALL, fixed shape rather than a passthrough of whatever the
// product sent. §3.4's stated purpose is "searchable records for the Directory
// and the command palette" — surfaces that show a name, say what kind of thing
// it is, and link onward. A record needing more than that is a product detail
// page, which is the product's own surface, not this one.
//
// Passing extra columns through would invite the console to render fields only
// one product emits, which is how a shared surface acquires per-product
// branches.
type Entity struct {
	ID string `json:"id"`
	// Source is REQUIRED and stamped from the slug the call was MADE to, never
	// read from the body. Two products' `users` are different populations, and
	// a row without its origin cannot be rendered honestly.
	Source string `json:"source"`
	// Type is the product-defined `{type}` this row came from, echoed so a
	// merged client need not track which request produced which row.
	Type  string `json:"type"`
	Label string `json:"label"`
	// Sublabel is what distinguishes two records sharing a Label — Kora sends
	// a user's handle (falling back to their email) and a food's brand.
	//
	// OPTIONAL, and its absence is a legitimate shape rather than a deviation:
	// §3.4 never defines the row at all, and mark8ly does not emit one. Two
	// implementers have already diverged here, which is exactly the gap where
	// a console grows a per-product branch if nobody writes it down.
	//
	// Carried because a directory without it is ambiguous in the one way a
	// directory must not be: two users called "Mahesh" render identically and
	// an operator has no way to tell them apart.
	Sublabel string `json:"sublabel,omitempty"`
	// CreatedAt is ISO 8601 with an offset per §4.3, kept as the string the
	// product sent. Optional: not every entity type has a creation instant
	// that means anything.
	CreatedAt string `json:"created_at,omitempty"`
}

// Pagination is §4.1's counters, echoed from the product.
//
// Echoed rather than recomputed: `total` is the PRODUCT's count of matching
// records, which is what a caller pages through. Substituting len(data) would
// silently claim the first page is the whole result.
type Pagination struct {
	Page  int `json:"page"`
	Limit int `json:"limit"`
	Total int `json:"total"`
}

// Page is the surface's response.
//
// No `failures` list, unlike the audit, tenants and inbox surfaces — and the
// absence is deliberate rather than an omission. Those fan out and can be
// partially right. This reads exactly ONE product, so there is no partial
// answer to describe: either that product answered or the request failed, and
// a failure is a status code rather than a row in a list.
type Page struct {
	Data       []Entity   `json:"data"`
	Pagination Pagination `json:"pagination"`
}
