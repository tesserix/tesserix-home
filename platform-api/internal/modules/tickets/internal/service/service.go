package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/write"
)

// ErrRefused means the request was understood and the domain declined it —
// a transition to the status a ticket already holds, an empty reply.
//
// Distinct from a malformed request and from a missing ticket, because the
// three are three different answers: 422, 400 and 404. Collapsing them would
// make "you asked for something impossible" indistinguishable from "you asked
// wrongly", and only one of those is worth a client retrying differently.
var ErrRefused = errors.New("the request was refused")

// Actor is the principal performing a write, reduced to what a reply and an
// audit row need.
type Actor struct {
	// Subject is the Zitadel `sub`. The audit trail's actor, the scope of an
	// idempotency key, and — since a reply no longer carries a name or an
	// email — the only attribution a reply row has. See Reply.
	Subject string
}

// displayName is how a platform reply is signed on a merchant's thread.
//
// The fixed label, unconditionally. This is NOT a fallback for missing
// profile data any more; it is the intended identity of the reply. Everything
// InsertReply is called with here is AuthorOperator — staff — and the person
// reading the row is a merchant, outside this organisation. Signing it with
// the operator's name or email would disclose a staff member's personal
// identity, and their personal email address, to a customer. A merchant is
// talking to the platform; the platform is what the reply should say.
//
// It stays a named function rather than an inlined literal because the label
// has a reason, and the reason belongs somewhere a reader will find it before
// deciding the constant looks like a stub.
//
// Never returns an empty string: author_name is NOT NULL and the console
// renders it directly, so an empty one produces a message that appears to be
// from nobody.
//
// A merchant's own replies do not come through here. That USED to be true
// because the console was the only caller; it is now true because authorFor
// routes them elsewhere — a machine relaying a merchant gets that merchant's
// name and never this label.
//
// The distinction matters to anyone changing the gates: this label is only
// safe while the reply route cannot reach it with a merchant's message behind
// it. #152 opened that route to a product's machine, and authorFor is what
// keeps the statement above true rather than merely historical. Widening who
// may reply without going through authorFor would file a merchant's words
// under the support team's name.
// The receiver is unnamed because the label deliberately does not depend on
// the actor. It stays a method on Actor so the call site still reads as "what
// this actor is shown as".
func (Actor) displayName() string {
	return "Tesserix Support"
}

// Service is the tickets module's operations over a pool.
type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// ---- reads --------------------------------------------------------------

// List reads one page of the queue.
func (s *Service) List(ctx context.Context, scope Scope, filter repository.Filter, limit int, cursor string) (ListPayload, repository.Page, error) {
	filter, err := scope.Apply(filter)
	if err != nil {
		return ListPayload{}, repository.Page{}, err
	}
	page, err := repository.List(ctx, s.pool, filter, limit, cursor)
	if err != nil {
		return ListPayload{}, repository.Page{}, err
	}
	return ListPayload{Tickets: toTickets(page.Tickets)}, page, nil
}

// Summary reads the standing count of the queue.
func (s *Service) Summary(ctx context.Context, scope Scope) (SummaryPayload, error) {
	summary, err := repository.Summary(ctx, s.pool, scope.ProductID)
	if err != nil {
		return SummaryPayload{}, err
	}
	return SummaryPayload{Summary: toSummary(summary)}, nil
}

// Detail reads one ticket and its thread.
//
// Both reads run in one transaction. Not for atomicity of a write — there is
// none — but so the thread cannot belong to a state of the ticket that the
// ticket read did not see. Without it, a reply landing between the two queries
// produces a response whose thread contains a message the ticket's updated_at
// does not account for, which reads as a stale ticket rather than a race.
func (s *Service) Detail(ctx context.Context, scope Scope, id string) (DetailPayload, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return DetailPayload{}, fmt.Errorf("beginning a read: %w", err)
	}
	// Rollback on every path. On the success path the transaction is already
	// committed and this is a no-op that returns pgx.ErrTxClosed, which is
	// why the error is discarded rather than logged.
	defer func() { _ = tx.Rollback(ctx) }()

	ticket, err := repository.Get(ctx, tx, id)
	if err != nil {
		return DetailPayload{}, err
	}
	if !scope.Admits(ticket.ProductID, ticket.TenantID) {
		// ErrNotFound, NOT a refusal. A 403 would confirm that this id names a
		// real ticket, letting a product enumerate the estate's ids one
		// request at a time. A caller outside its scope is told the same thing
		// as a caller naming an id that never existed.
		//
		// The thread is deliberately not read before this check.
		return DetailPayload{}, repository.ErrNotFound
	}
	replies, err := repository.Replies(ctx, tx, id)
	if err != nil {
		return DetailPayload{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DetailPayload{}, fmt.Errorf("committing a read: %w", err)
	}
	return DetailPayload{Ticket: toTicket(ticket), Replies: toReplies(replies)}, nil
}

// ---- writes -------------------------------------------------------------
//
// Every write goes through write.Perform, which binds it to its audit row and
// its idempotency record in one transaction. What is left here is the domain:
// what to do, what to answer with, and what to call the action in the trail.

// ReplyInput is a new message, optionally transitioning the ticket with it.
type ReplyInput struct {
	Content string
	// NewStatus is nil for a plain reply.
	//
	// The transition travels WITH the reply rather than as a second call, and
	// that is a contract decision rather than a convenience. Two calls can
	// half-fail: the merchant gets an answer on a ticket that stays open, or
	// the ticket closes under a reply that never landed. There is no
	// transaction across two HTTP requests to put that right, and the console
	// already relies on this being one call.
	NewStatus *domain.Status
	// Author is the merchant a product's machine is relaying. Nil for an
	// operator's own reply. authorFor turns this into the stored attribution
	// and refuses the combinations that must not happen.
	Author *Author
}

// Reply appends a message and, optionally, transitions the ticket.
func (s *Service) Reply(ctx context.Context, scope Scope, actor Actor, ticketID string, input ReplyInput, key *idempotency.Key) (write.Result, error) {
	content := strings.TrimSpace(input.Content)
	if content == "" {
		// Trimmed first: a reply of spaces is an empty reply, and storing one
		// would put a blank message on a merchant's thread.
		return write.Result{}, fmt.Errorf("%w: a reply needs content", ErrRefused)
	}
	if len(content) > domain.MaxReplyLength {
		return write.Result{}, fmt.Errorf("%w: a reply is limited to %d characters", ErrRefused, domain.MaxReplyLength)
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		ticket, err := repository.Get(ctx, tx, ticketID)
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}
		if !scope.Admits(ticket.ProductID, ticket.TenantID) {
			// Same non-disclosure as Detail, and checked INSIDE the
			// transaction that will write, so the ticket whose ownership was
			// verified is the ticket the reply lands on.
			return nil, audit.Entry{}, 0, repository.ErrNotFound
		}

		// Who the reply is from, and what it does to the ticket — both settled
		// BEFORE anything is written, so a refusal costs no insert and does
		// not depend on the rollback to be correct.
		//
		// Attribution is no longer unconditional. An OPERATOR's reply is
		// signed with the platform's fixed label and no email, because a
		// merchant reads this row and neither a staff member's name nor their
		// personal address is theirs to see; the subject is still kept in
		// AuthorUserID, so who replied is recorded without being shown. A
		// MACHINE's reply is the MERCHANT it names. authorFor holds both
		// rules, and refuses the combinations that must not happen — an
		// operator posting as a merchant, or a machine declining to say.
		//
		// The repository wraps an empty email in nullIfEmpty
		// (repository/tickets.go), so the column goes NULL rather than
		// holding a blank string.
		author, err := authorFor(scope, actor, input.Author)
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}

		// What the reply does to the ticket, and what the trail calls it.
		// Decided from the ticket's own state — see replyEffect, which is
		// where the merchant reopen and the closed-ticket refusal live, and
		// where they are tested without a database.
		newStatus, action, err := replyEffect(author, ticket.Status, input.NewStatus)
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}

		reply, err := repository.InsertReply(ctx, tx, domain.Reply{
			TicketID:     ticketID,
			AuthorType:   author.Type,
			AuthorName:   author.Name,
			AuthorEmail:  author.Email,
			AuthorUserID: author.UserID,
			Content:      content,
		})
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}

		summary := map[string]int{"replies": 1, "status_changes": 0}

		if newStatus != nil {
			if err := ticket.Transition(*newStatus); err != nil {
				return nil, audit.Entry{}, 0, fmt.Errorf("%w: %s", ErrRefused, err)
			}
			if ticket, err = repository.SetStatus(ctx, tx, ticketID, *newStatus); err != nil {
				return nil, audit.Entry{}, 0, err
			}
			summary["status_changes"] = 1
		} else {
			// Re-read so the response carries the ticket as the reply left it.
			// platform_tickets has a BEFORE UPDATE trigger on updated_at, but
			// a reply is an insert into another table and does not fire it —
			// so this is the row unchanged, and returning the one read at the
			// top would be equally correct. Re-read anyway, because "the
			// ticket as it now stands" should not depend on a reader knowing
			// which writes touch which triggers.
			if ticket, err = repository.Get(ctx, tx, ticketID); err != nil {
				return nil, audit.Entry{}, 0, err
			}
		}

		payload := ReplyPayload{Reply: toReply(reply), Ticket: toTicket(ticket)}
		return payload, audit.Entry{
			Actor:  actor.Subject,
			Action: action,
			Target: ticketID,
			// Counts, never content. The reply's text is the merchant's
			// conversation and already lives one table away.
			Summary: summary,
		}, http.StatusCreated, nil
	})
}

// SetStatus transitions a ticket.
func (s *Service) SetStatus(ctx context.Context, actor Actor, ticketID string, to domain.Status, key *idempotency.Key) (write.Result, error) {
	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		ticket, err := repository.Get(ctx, tx, ticketID)
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}
		if err := ticket.Transition(to); err != nil {
			return nil, audit.Entry{}, 0, fmt.Errorf("%w: %s", ErrRefused, err)
		}

		// Named before the update, from the state the ticket was in. Asking
		// afterwards would always answer "no": the ticket is no longer
		// terminal once it has been reopened.
		action := "tickets.status"
		if ticket.Reopening(to) {
			action = "tickets.reopen"
		}

		updated, err := repository.SetStatus(ctx, tx, ticketID, to)
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}

		return StatusPayload{Ticket: toTicket(updated)}, audit.Entry{
			Actor:   actor.Subject,
			Action:  action,
			Target:  ticketID,
			Summary: map[string]int{"status_changes": 1},
		}, http.StatusOK, nil
	})
}
