// Package domain holds the tenants module's types.
package domain

// Tenant is one tenant, from any product that has them.
//
// Field names and json tags are the wire shape the console reads. They mirror
// the contract's §3.4 entity row as mark8ly serves it — `id`, `name`,
// `owner_email`, `status`, `created_at` — with `source` added here, the same
// way the audit module stamps its rows.
type Tenant struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// OwnerEmail is optional: a product may have tenants without a single
	// owner, and omitting is honest where inventing one would not be.
	OwnerEmail string `json:"owner_email,omitempty"`
	// Status is the product's own vocabulary, passed through rather than
	// normalised. "active" means whatever the product means by it, and a
	// console-side translation table would be a second vocabulary that drifts
	// from the first — see the §4.6 route-identity argument, which is the same
	// shape of problem.
	Status string `json:"status"`
	// CreatedAt is ISO 8601 with an offset, per §4.3. Carried as a string
	// rather than a time.Time because this module never sorts on it — the
	// products each return their own page and the console renders what it is
	// given. Parsing it here would buy nothing and could fail a whole page on
	// one malformed row.
	CreatedAt string `json:"created_at,omitempty"`
	// Source is REQUIRED on every row, for the reason the audit module states:
	// "who" without "where" is not a whole answer, and the console renders
	// this column.
	Source string `json:"source"`
}

// Failure is one product that could not be read, in the shape the console
// renders. Deliberately the same shape the audit module emits — the console
// already has a renderer for it, and two spellings of "this source failed"
// across two surfaces is how a shared component stops being shared.
type Failure struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

// Page is the surface's response: what was read, and what could not be.
//
// Both slices are non-nil even when empty. A nil slice serialises as `null`,
// which defeats every caller's `?? []` and has already crashed a console page
// in this estate precisely when there was no data.
type Page struct {
	Tenants  []Tenant  `json:"tenants"`
	Failures []Failure `json:"failures"`
}
