// Package write binds a mutation, its audit row and its idempotency record
// into ONE transaction. Kernel, not a module — every module that mutates uses
// it, and it depends on no module.
//
// # Where it came from
//
// This was `service.perform` inside the tickets module, with a note on it
// saying it was a candidate for the kernel rather than kernel, and that it
// would move when a second module needed it — because a shape extracted from
// one example is a guess, and the second module is what shows whether the seam
// is where it looks. The CRM queues module is that second example. See
// "What the second module showed" below for the answer, which is the part
// worth reading; the note itself has served its purpose and is gone.
//
// # The name
//
// `internal/platform/write`, so the call site reads `write.Perform(ctx, pool,
// key, …)`. The package carries the verb and the type names stay short —
// Operation, Result — the way `audit.Entry` and `idempotency.Key` do. The
// alternative considered was folding this into `idempotency`, since that
// package already owns the replay half; it was rejected because the audit row
// and the transaction have nothing to do with idempotency, and a write with no
// key still needs all of this.
//
// # What the second module showed
//
// The guess held, with one detail promoted from incidental to load-bearing.
//
// CRM's simplest write — a single-column UPDATE on crm_opportunities, audited,
// with an optional key — is strictly less than either ticket write. It has no
// multi-statement operation and no payload derived from anything but the row
// it touched, and it needed no part of this that tickets had not already
// exercised. So the seam is not in the wrong place, and it is not too narrow.
//
// The load-bearing detail is that Operation returns its audit.Entry AFTER
// doing the work, rather than the caller declaring the entry up front. In
// tickets that looks like an accident of layout: only "tickets.reopen" versus
// "tickets.status" depends on anything read inside the transaction, and even
// that is decided before the UPDATE. CRM leans on it properly — some of its
// verbs choose between "crm.stage.change" and "crm.product.set" according to
// what the write actually changed. The ordering is therefore a requirement,
// not a style: a refactor that asks for the entry before the operation runs
// makes those verbs inexpressible.
//
// Two further CRM behaviours were checked against this shape and needed no
// change to it, which is recorded here because the next person will ask:
//
//   - A verb with a legitimate no-op outcome that still writes an audit row
//     returns a nil error, a payload describing the no-op, and its entry. The
//     audit row lands and the transaction commits, because only an error rolls
//     back. "Nothing changed" is an outcome here, not a refusal — a module
//     signals a refusal with an error of its own.
//   - The status is per-operation rather than per-package, so a verb answering
//     200 sits beside one answering 201 without either knowing about the other.
package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
)

// Result is what a write produced: the status and body to answer with.
//
// The body is already JSON because it may have been stored for replay inside
// the transaction that produced it — see Perform. A caller writes it through
// the envelope like any other payload; json.RawMessage passes through
// unchanged.
type Result struct {
	Status int
	Body   json.RawMessage
}

// Operation is one write: it does the work, and says what to record and what
// to answer with.
//
// It is handed the transaction rather than opening its own, so everything it
// does lands or none of it does. Returning an error abandons the whole thing,
// audit row included; returning nil commits it.
//
// The audit.Entry comes back AFTER the work for a reason the package comment
// gives at length: a module that picks its action from what the write actually
// changed can only do so here.
type Operation func(ctx context.Context, tx pgx.Tx) (payload any, entry audit.Entry, status int, err error)

// Perform runs a write, its audit row and its idempotency record in ONE
// transaction.
//
// The pool is the module's own — this package holds no state and no
// connection. It is a *pgxpool.Pool rather than an interface because Perform
// needs both Begin and the pool itself for the two replay lookups, and pgx
// offers no interface spanning them.
//
// # Why all three are in the same transaction
//
// The audit row: ADR-003 D2a cites `auditedOperation`'s guarantee — that an
// unauditable operation does not proceed — as a reason not to split the
// modules into services. Here the guarantee is structural rather than ordered:
// a failed audit rolls the write back, and there is no window in which the
// write has landed and the record has not.
//
// The idempotency record: a key in the table must always correspond to a
// committed write. Recording outside the transaction would refuse the retry of
// a request that never landed, which is worse than not having the feature at
// all — the caller would be told their write was already applied.
func Perform(ctx context.Context, pool *pgxpool.Pool, key *idempotency.Key, op Operation) (Result, error) {
	// The replay check runs OUTSIDE the transaction and before the work. A
	// retry should cost a single indexed lookup, not a transaction that does
	// the whole operation and then discards it.
	if key != nil {
		stored, err := idempotency.Lookup(ctx, pool, *key)
		if err != nil {
			return Result{}, err
		}
		if stored != nil {
			return Result{Status: stored.Status, Body: stored.Body}, nil
		}
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("beginning a write: %w", err)
	}
	// Rollback on every path that is not an explicit commit. On the committed
	// path this is a no-op.
	defer func() { _ = tx.Rollback(ctx) }()

	payload, entry, status, err := op(ctx, tx)
	if err != nil {
		return Result{}, err
	}

	body, err := json.Marshal(payload)
	if err != nil {
		// Inside the transaction on purpose: the stored replay body must be
		// the same bytes the first caller received, and marshalling after the
		// commit would leave a committed write with nothing recorded for it.
		return Result{}, fmt.Errorf("encoding the response: %w", err)
	}

	if err := audit.Write(ctx, tx, entry); err != nil {
		return Result{}, err
	}

	if key != nil {
		won, err := idempotency.Record(ctx, tx, *key, status, body)
		if err != nil {
			return Result{}, err
		}
		if !won {
			// A concurrent request with the same key committed first. Ours is
			// the duplicate: abandon it — the deferred rollback does that —
			// and answer with what the winner produced.
			//
			// Reached only under a genuine double-submit, which is exactly
			// what the key exists to make harmless.
			stored, err := idempotency.Lookup(ctx, pool, *key)
			if err != nil {
				return Result{}, err
			}
			if stored == nil {
				// The winner committed its key and then... did not. Not
				// reachable through this code path, since Record and the
				// commit share a transaction, but reported rather than
				// retried: an unexplained state should not become a loop.
				return Result{}, errors.New("an idempotency key was claimed by a request that left no response")
			}
			return Result{Status: stored.Status, Body: stored.Body}, nil
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return Result{}, fmt.Errorf("committing a write: %w", err)
	}
	return Result{Status: status, Body: body}, nil
}
