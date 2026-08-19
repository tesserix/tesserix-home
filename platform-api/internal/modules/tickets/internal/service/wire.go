// Package service holds the tickets module's operations: the wire
// representations it answers with, and the transaction scripts behind its two
// write verbs.
//
// Under modules/tickets/internal/, so only code rooted at modules/tickets/ can
// import it.
package service

import (
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
)

// # The wire shapes, and why they are not the screen's
//
// #269's complaint about the endpoints being replaced is that they are
// screen-shaped: `GET /api/admin/platform-tickets` returns
// `{summary, rows}` — a standing count of the whole queue welded to a filtered
// page of it, because one React component wanted both. No product would ask
// for that object, and no second console screen would either.
//
// So the two are separate resources here. The console composes them in its
// route handler, which is a layer it already has: lib/platform-api.ts is a
// composition layer today, just pointed at the wrong backend.
//
// The cost is one extra request on the queue screen. The thing it buys is that
// `summary` can be cached, polled or dropped independently of the listing, and
// that a product consuming tickets is not made to fetch a console header it
// will never render.
//
// # snake_case
//
// The estate's spelling, and what the console's existing parsers already
// accept first (`r.product_id ?? r.productId`). Choosing camelCase would have
// been a gratuitous difference from ~30 other services for no reader's gain.

// Ticket is one ticket on the wire.
//
// submitted_by_user_id is deliberately absent, as is the reply author's. They
// are attribution the database keeps; the console renders a name and an email,
// and putting a third-party identifier (a Firebase UID, a Zitadel subject) on
// the wire would publish a join key to every caller for no reader's benefit.
type Ticket struct {
	ID               string `json:"id"`
	ProductID        string `json:"product_id"`
	TenantID         string `json:"tenant_id"`
	TicketNumber     string `json:"ticket_number"`
	Subject          string `json:"subject"`
	Description      string `json:"description"`
	Status           string `json:"status"`
	Priority         string `json:"priority"`
	SubmittedByName  string `json:"submitted_by_name"`
	SubmittedByEmail string `json:"submitted_by_email"`
	// resolved_at is null rather than absent when a ticket has never been
	// resolved. The console's parser reads it as `string | null` and renders
	// the difference; an omitted key and a null are the same thing to it, but
	// a null says "asked and unanswered" to anything stricter.
	ResolvedAt *time.Time `json:"resolved_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// Reply is one message on a thread.
type Reply struct {
	ID          string    `json:"id"`
	TicketID    string    `json:"ticket_id"`
	AuthorType  string    `json:"author_type"`
	AuthorName  string    `json:"author_name"`
	AuthorEmail string    `json:"author_email"`
	Content     string    `json:"content"`
	CreatedAt   time.Time `json:"created_at"`
}

// Summary is the standing count of the queue — its own resource, not a header
// on the listing. See the note above.
type Summary struct {
	Open             int `json:"open"`
	InProgress       int `json:"in_progress"`
	ResolvedThisWeek int `json:"resolved_this_week"`
	UrgentOpen       int `json:"urgent_open"`
}

// The payload wrappers. Every response names its resource — {"tickets": […]},
// {"ticket": …, "replies": […]} — rather than answering with a bare array or a
// bare object.
//
// A named object can gain a sibling field without becoming a different type,
// which a bare array cannot: adding one datum beside a top-level array is a
// breaking change for every client, and this contract is one products pin to.
type (
	ListPayload struct {
		Tickets []Ticket `json:"tickets"`
	}
	SummaryPayload struct {
		Summary Summary `json:"summary"`
	}

	DetailPayload struct {
		Ticket  Ticket  `json:"ticket"`
		Replies []Reply `json:"replies"`
	}

	// ReplyPayload carries the ticket as well as the reply.
	//
	// Not padding: a reply may transition the ticket in the same request, so
	// the caller needs the resulting state, and re-reading it would be a
	// second round trip that could observe a third party's change instead.
	ReplyPayload struct {
		Reply  Reply  `json:"reply"`
		Ticket Ticket `json:"ticket"`
	}

	StatusPayload struct {
		Ticket Ticket `json:"ticket"`
	}
)

func toTicket(t domain.Ticket) Ticket {
	return Ticket{
		ID:               t.ID,
		ProductID:        t.ProductID,
		TenantID:         t.TenantID,
		TicketNumber:     t.TicketNumber,
		Subject:          t.Subject,
		Description:      t.Description,
		Status:           string(t.Status),
		Priority:         string(t.Priority),
		SubmittedByName:  t.SubmittedByName,
		SubmittedByEmail: t.SubmittedByEmail,
		ResolvedAt:       t.ResolvedAt,
		CreatedAt:        t.CreatedAt,
		UpdatedAt:        t.UpdatedAt,
	}
}

func toTickets(tickets []domain.Ticket) []Ticket {
	// Non-nil, so an empty page serialises as [] rather than null. A client
	// that types the field as an array meets a type error on the one response
	// it is least likely to have exercised.
	out := make([]Ticket, 0, len(tickets))
	for _, t := range tickets {
		out = append(out, toTicket(t))
	}
	return out
}

func toReply(r domain.Reply) Reply {
	return Reply{
		ID:          r.ID,
		TicketID:    r.TicketID,
		AuthorType:  string(r.AuthorType),
		AuthorName:  r.AuthorName,
		AuthorEmail: r.AuthorEmail,
		Content:     r.Content,
		CreatedAt:   r.CreatedAt,
	}
}

func toReplies(replies []domain.Reply) []Reply {
	out := make([]Reply, 0, len(replies))
	for _, r := range replies {
		out = append(out, toReply(r))
	}
	return out
}

func toSummary(s domain.Summary) Summary {
	return Summary{
		Open:             s.Open,
		InProgress:       s.InProgress,
		ResolvedThisWeek: s.ResolvedThisWeek,
		UrgentOpen:       s.UrgentOpen,
	}
}
