package service

import (
	"context"
	"encoding/json"
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
	// Subject is the Zitadel `sub`. The audit trail's actor and the scope of
	// an idempotency key.
	Subject string
	// Name and Email are what the console renders beside the message. A
	// machine principal usually has neither, which is why neither is required.
	Name  string
	Email string
}

// displayName is what appears on the thread.
//
// Falls back through email to a fixed label rather than writing an empty
// string: author_name is NOT NULL and the console renders it directly, so an
// empty one produces a message that appears to be from nobody. "Tesserix
// Support" is honest for a service principal — the merchant is talking to the
// platform, not to a named person.
func (a Actor) displayName() string {
	switch {
	case a.Name != "":
		return a.Name
	case a.Email != "":
		return a.Email
	default:
		return "Tesserix Support"
	}
}

// Service is the tickets module's operations over a pool.
type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// ---- reads --------------------------------------------------------------

// List reads one page of the queue.
func (s *Service) List(ctx context.Context, filter repository.Filter, limit int, cursor string) (ListPayload, repository.Page, error) {
	page, err := repository.List(ctx, s.pool, filter, limit, cursor)
	if err != nil {
		return ListPayload{}, repository.Page{}, err
	}
	return ListPayload{Tickets: toTickets(page.Tickets)}, page, nil
}

// Summary reads the standing count of the queue.
func (s *Service) Summary(ctx context.Context) (SummaryPayload, error) {
	summary, err := repository.Summary(ctx, s.pool)
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
func (s *Service) Detail(ctx context.Context, id string) (DetailPayload, error) {
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

// Written is what a write produced: the status and body to answer with.
//
// The body is already JSON because it may have been stored for replay inside
// the transaction that produced it — see perform. A caller writes it through
// the envelope like any other payload; json.RawMessage passes through
// unchanged.
type Written struct {
	Status int
	Body   json.RawMessage
}

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
}

// Reply appends a message and, optionally, transitions the ticket.
func (s *Service) Reply(ctx context.Context, actor Actor, ticketID string, input ReplyInput, key *idempotency.Key) (Written, error) {
	content := strings.TrimSpace(input.Content)
	if content == "" {
		// Trimmed first: a reply of spaces is an empty reply, and storing one
		// would put a blank message on a merchant's thread.
		return Written{}, fmt.Errorf("%w: a reply needs content", ErrRefused)
	}
	if len(content) > domain.MaxReplyLength {
		return Written{}, fmt.Errorf("%w: a reply is limited to %d characters", ErrRefused, domain.MaxReplyLength)
	}

	return s.perform(ctx, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		ticket, err := repository.Get(ctx, tx, ticketID)
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}

		reply, err := repository.InsertReply(ctx, tx, domain.Reply{
			TicketID:     ticketID,
			AuthorType:   domain.AuthorOperator,
			AuthorName:   actor.displayName(),
			AuthorEmail:  actor.Email,
			AuthorUserID: actor.Subject,
			Content:      content,
		})
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}

		action := "tickets.reply"
		summary := map[string]int{"replies": 1, "status_changes": 0}
		if input.NewStatus != nil {
			if err := ticket.Transition(*input.NewStatus); err != nil {
				return nil, audit.Entry{}, 0, fmt.Errorf("%w: %s", ErrRefused, err)
			}
			if ticket, err = repository.SetStatus(ctx, tx, ticketID, *input.NewStatus); err != nil {
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
func (s *Service) SetStatus(ctx context.Context, actor Actor, ticketID string, to domain.Status, key *idempotency.Key) (Written, error) {
	return s.perform(ctx, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
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

// operation is one write: it does the work, and says what to record and what
// to answer with.
type operation func(ctx context.Context, tx pgx.Tx) (payload any, entry audit.Entry, status int, err error)

// perform runs a write, its audit row and its idempotency record in ONE
// transaction.
//
// # Why all three are in the same transaction
//
// The audit row: ADR-003 D2a cites `auditedOperation`'s guarantee — that an
// unauditable operation does not proceed — as a reason not to split these
// modules into services. Here the guarantee is structural rather than ordered:
// a failed audit rolls the write back, and there is no window in which the
// write has landed and the record has not.
//
// The idempotency record: a key in the table must always correspond to a
// committed write. Recording outside the transaction would refuse the retry of
// a request that never landed, which is worse than not having the feature at
// all — the caller would be told their write was already applied.
//
// # This is a candidate for the kernel, not yet kernel
//
// Every module's writes will want exactly this. It stays here until a second
// module needs it, because a shape extracted from one example is a guess: the
// second module is what will show whether the seam is where it looks.
func (s *Service) perform(ctx context.Context, key *idempotency.Key, op operation) (Written, error) {
	// The replay check runs OUTSIDE the transaction and before the work. A
	// retry should cost a single indexed lookup, not a transaction that does
	// the whole operation and then discards it.
	if key != nil {
		stored, err := idempotency.Lookup(ctx, s.pool, *key)
		if err != nil {
			return Written{}, err
		}
		if stored != nil {
			return Written{Status: stored.Status, Body: stored.Body}, nil
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Written{}, fmt.Errorf("beginning a write: %w", err)
	}
	// Rollback on every path that is not an explicit commit. On the committed
	// path this is a no-op.
	defer func() { _ = tx.Rollback(ctx) }()

	payload, entry, status, err := op(ctx, tx)
	if err != nil {
		return Written{}, err
	}

	body, err := json.Marshal(payload)
	if err != nil {
		// Inside the transaction on purpose: the stored replay body must be
		// the same bytes the first caller received, and marshalling after the
		// commit would leave a committed write with nothing recorded for it.
		return Written{}, fmt.Errorf("encoding the response: %w", err)
	}

	if err := audit.Write(ctx, tx, entry); err != nil {
		return Written{}, err
	}

	if key != nil {
		won, err := idempotency.Record(ctx, tx, *key, status, body)
		if err != nil {
			return Written{}, err
		}
		if !won {
			// A concurrent request with the same key committed first. Ours is
			// the duplicate: abandon it — the deferred rollback does that —
			// and answer with what the winner produced.
			//
			// Reached only under a genuine double-submit, which is exactly
			// what the key exists to make harmless.
			stored, err := idempotency.Lookup(ctx, s.pool, *key)
			if err != nil {
				return Written{}, err
			}
			if stored == nil {
				// The winner committed its key and then... did not. Not
				// reachable through this code path, since Record and the
				// commit share a transaction, but reported rather than
				// retried: an unexplained state should not become a loop.
				return Written{}, errors.New("an idempotency key was claimed by a request that left no response")
			}
			return Written{Status: stored.Status, Body: stored.Body}, nil
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return Written{}, fmt.Errorf("committing a write: %w", err)
	}
	return Written{Status: status, Body: body}, nil
}
