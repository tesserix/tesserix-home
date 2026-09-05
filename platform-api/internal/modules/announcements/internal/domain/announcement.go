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
