// Package domain holds the announcements module's types.
//
// Under modules/announcements/internal/, so only code rooted at
// modules/announcements/ can import it.
package domain

import "time"

// Severity is how loudly an announcement is shown.
//
// The four values the CHECK constraint on platform_announcements permits
// (migration 0002). Not parsed on the way out — the column is constrained, so
// a value that is not one of these cannot be in the database, and a parser
// here would be a second place to keep in step for no gain.
type Severity string

const (
	SeverityInfo        Severity = "info"
	SeverityWarning     Severity = "warning"
	SeverityMaintenance Severity = "maintenance"
	SeverityIncident    Severity = "incident"
)

// Announcement is one broadcast, as the platform stores it.
//
// # What is deliberately absent
//
// `audience_filter` is NOT here, and that is a disclosure decision rather than
// an oversight. It names the OTHER products and tenant statuses a broadcast
// targets, so returning it to mark8ly would tell mark8ly that Kora exists and
// is being addressed. A product needs to know what to show, not who else was
// addressed.
//
// `created_by` is absent for the same reason a ticket reply is signed by the
// platform: it identifies a member of staff to a customer.
//
// `is_published` is absent because it is always true by construction — the
// only query that produces these filters on it — and a field that is always
// the same value invites a caller to branch on something that cannot vary.
type Announcement struct {
	ID       string
	Title    string
	Body     string
	Severity Severity
	StartsAt time.Time
	// EndsAt is nil for an announcement with no scheduled end.
	EndsAt *time.Time
}

// Authored is one announcement as an OPERATOR sees it.
//
// A different shape from Announcement, not a superset by accident. The three
// extra fields are exactly the ones withheld from products, and each is
// withheld for a stated reason: `AudienceFilter` names the other products a
// broadcast targets, `CreatedBy` identifies staff to a customer, and
// `IsPublished` is always true in what a product receives.
//
// An operator authoring a broadcast needs all three — they are the targeting,
// the attribution and the draft state. Serving both audiences one shape would
// mean either leaking to products or blinding operators.
type Authored struct {
	Announcement
	// AudienceFilter is the raw JSONB, passed through rather than parsed. The
	// schema comment calls it "intentionally permissive so we can grow filters
	// without a migration", and a Go struct here would be the migration that
	// comment exists to avoid.
	AudienceFilter map[string]any
	IsPublished    bool
	// CreatedBy is the operator's Zitadel subject, or empty for rows authored
	// before the column was populated.
	CreatedBy string
	UpdatedAt time.Time
}
