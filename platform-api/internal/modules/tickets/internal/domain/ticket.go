// Package domain holds the tickets module's types and rules.
//
// Under modules/tickets/internal/, so only code rooted at modules/tickets/ can
// import it — the compiler enforces that, not a convention.
package domain

import (
	"fmt"
	"slices"
	"time"
)

// Status is a ticket's lifecycle position.
//
// The values are the ones the `pt_status_chk` CHECK constraint permits. Adding
// one here without a migration produces a row the database refuses, which is
// the right way round: the schema is authoritative and this mirrors it.
type Status string

const (
	StatusOpen       Status = "open"
	StatusInProgress Status = "in_progress"
	StatusResolved   Status = "resolved"
	StatusClosed     Status = "closed"
)

var statuses = []Status{StatusOpen, StatusInProgress, StatusResolved, StatusClosed}

// ParseStatus narrows a caller-supplied string.
//
// Returns an error rather than a bool so the caller cannot forget to check: a
// silently-ignored bad status would write nothing and report success.
func ParseStatus(raw string) (Status, error) {
	s := Status(raw)
	if !slices.Contains(statuses, s) {
		return "", fmt.Errorf("unknown status %q (want one of %v)", raw, statuses)
	}
	return s, nil
}

// Priority is how loud a ticket is.
//
// Deliberately NOT an SLA. `platform_tickets` has no deadline column and no
// agreed response target, so anything resembling "overdue" would be invented —
// the same reasoning lib/tickets.ts records for `severityOf`.
type Priority string

const (
	PriorityLow    Priority = "low"
	PriorityMedium Priority = "medium"
	PriorityHigh   Priority = "high"
	PriorityUrgent Priority = "urgent"
)

var priorities = []Priority{PriorityLow, PriorityMedium, PriorityHigh, PriorityUrgent}

func ParsePriority(raw string) (Priority, error) {
	p := Priority(raw)
	if !slices.Contains(priorities, p) {
		return "", fmt.Errorf("unknown priority %q (want one of %v)", raw, priorities)
	}
	return p, nil
}

// AuthorType is who wrote a reply.
//
// Validated rather than carried through as a string: it decides whether a
// message renders as the merchant's or the operator's, and a misattributed
// message is worse than a failed read. parseTicketDetail on the console side
// rejects an unknown value for the same reason.
type AuthorType string

const (
	AuthorMerchant AuthorType = "merchant"
	AuthorOperator AuthorType = "platform_admin"
)

// Ticket is one support request.
type Ticket struct {
	ID               string
	ProductID        string
	TenantID         string
	TicketNumber     string
	Subject          string
	Description      string
	Status           Status
	Priority         Priority
	SubmittedByName  string
	SubmittedByEmail string
	ResolvedAt       *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// Reply is one message on a ticket's thread. Append-only.
type Reply struct {
	ID          string
	TicketID    string
	AuthorType  AuthorType
	AuthorName  string
	AuthorEmail string
	Content     string
	CreatedAt   time.Time

	// AuthorUserID is the author's identifier at their own issuer — a Zitadel
	// `sub` for an operator, a Firebase UID for a merchant forwarded from a
	// product's admin app.
	//
	// Written but never read back into a response. It is attribution the
	// database keeps, and the console renders a name and an email; putting a
	// third-party identifier on the wire would publish a join key to every
	// caller for no reader's benefit.
	//
	// The column is TEXT, not uuid. Migration 0003 relaxed it for exactly this
	// reason: Firebase UIDs are 28-character base62, and storing a foreign
	// identifier as uuid fails the implicit cast and lies about its shape.
	AuthorUserID string
}

// MaxReplyLength bounds one message.
//
// 10,000 characters, matching apps/web's replySchema and the console's
// MAX_REPLY_LENGTH. Three copies of one number is two too many, and the
// alternative — the console importing it from here — does not exist across the
// language boundary. It is asserted rather than assumed: a reply the console
// accepts and this rejects would fail after the operator has typed it.
const MaxReplyLength = 10_000

// Summary is the standing count of the queue.
//
// Deliberately NOT computed over a filtered listing: it is a property of the
// queue, and recomputing it per filter would make the headline numbers move as
// an operator narrows the list.
type Summary struct {
	Open             int
	InProgress       int
	ResolvedThisWeek int
	UrgentOpen       int
}

// Transition reports whether a status change is allowed.
//
// One rule: a ticket may move to any other state, and may not move to the one
// it is already in.
//
// # Why a no-op is refused
//
// It keeps "a transition happened" and "a row was updated" the same statement.
// A permitted no-op would write an audit row recording a change nobody made,
// and — through the reply endpoint, where a transition rides along with a
// message — could stamp resolved_at on a ticket whose status did not move.
//
// # Why reopening a closed ticket is NOT refused
//
// An earlier draft of this file refused it, arguing that reopening needs a
// record of who did it and why, and that "nothing in the schema records who
// reopened what". That was a fair reading of the schema and it no longer
// holds here: every write this module makes is audited in the same
// transaction, so a reopen lands in console_audit_log with an actor, an
// action and a target. The objection was to an unrecorded act, and the act is
// now recorded.
//
// It would also have broken a control the console ships today.
// respond-controls.tsx renders Reopen for any terminal status — resolved AND
// closed — and apps/web's PATCH permits it. Refusing it here would turn a
// working button into a rejection on the one surface #269 is migrating, which
// is the opposite of what a migration is for. A rule the UI contradicts is not
// a stricter domain; it is a bug with a comment.
func (t Ticket) Transition(to Status) error {
	if t.Status == to {
		return fmt.Errorf("ticket is already %s", to)
	}
	return nil
}

// Reopening reports whether this transition brings a terminal ticket back into
// the queue.
//
// Its own predicate because the audit trail distinguishes it. `tickets.reopen`
// and `tickets.status` are different questions asked of the log — "what was
// undone" is not answerable by scanning status changes in general — and the
// distinction is only cheap to draw at the moment the transition is decided.
func (t Ticket) Reopening(to Status) bool {
	return t.terminal() && !isTerminal(to)
}

func (t Ticket) terminal() bool { return isTerminal(t.Status) }

// isTerminal mirrors isTerminalStatus in the console's lib/tickets.ts. The two
// lists must agree: the console decides whether to render Reopen from its copy,
// and this decides what the act is called in the audit trail from ours.
func isTerminal(s Status) bool {
	return s == StatusResolved || s == StatusClosed
}

// ResolvesAt reports whether moving to `to` should stamp resolved_at.
//
// Stamped once and never cleared: `resolved_at` records WHEN a ticket was first
// resolved, and a ticket that bounced between in_progress and resolved should
// not lose its original resolution time.
func (t Ticket) ResolvesAt(to Status) bool {
	return to == StatusResolved && t.ResolvedAt == nil
}
