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
// "What the second example shows" below for the answer, which is the part
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
// # What the second example shows
//
// The CRM queues module is that second example. Its Go implementation follows;
// at the time of the extraction this package has exactly one caller, and the
// shape was checked against the console's EXISTING CRM writes rather than
// against a Go module that does not exist yet. Those writes are real and
// checkable — that is the evidence below, and it is deliberately not stated as
// a Go module having needed this, because the compiler does not back that.
//
// So: a guess re-examined against a second, independently-written example,
// not a shape a second compiler-checked caller has yet exercised. Read the
// confidence accordingly.
//
// On that evidence the shape holds, with one detail promoted from incidental
// to load-bearing.
//
// CRM's simplest write — a single-column UPDATE on crm_opportunities, audited
// as "crm.next_action.set", with an optional key — is strictly less than
// either ticket write. It has no multi-statement operation and no payload
// derived from anything but the row it touched, and it asks for no part of
// this that tickets had not already exercised. So the seam is not in the wrong
// place, and it is not too narrow.
//
// The load-bearing detail is that Operation returns its audit.Entry AFTER
// doing the work, rather than the caller declaring the entry up front. In
// tickets that looks like an accident of layout: only "tickets.reopen" versus
// "tickets.status" depends on anything read inside the transaction, and even
// that is decided before the UPDATE. The console's advanceStage
// (apps/console/app/(console)/platform/crm/[organisation]/actions.ts) leans on
// it properly — it passes an outcome -> {action, summary} function that
// chooses "crm.stage.change" or "crm.product.set" by what the write actually
// changed. A signature demanding the entry up front cannot express that, so
// the ordering here is a requirement rather than a style.
//
// Two further behaviours of those same console writes were checked against
// this shape and need no change to it, which is recorded here because the next
// person will ask:
//
//   - A verb with a legitimate no-op outcome that still writes an audit row
//     returns a nil error, a payload describing the no-op, and its entry. The
//     audit row lands and the transaction commits, because only an error rolls
//     back. "Nothing changed" is an outcome here, not a refusal — a module
//     signals a refusal with an error of its own. advanceStage's third branch
//     is exactly this: a real audit row with {transitions: 0}.
//   - The status is per-operation rather than per-package, so a verb answering
//     200 sits beside one answering 201 without either knowing about the other.
//
// # More than one audit row in a transaction
//
// Undocumented until now, and safe: the Operation holds the transaction, so a
// verb needing a second audit row calls audit.Write(ctx, tx, ...) itself for
// the extras and returns the principal one. They share the transaction, so the
// same all-or-nothing guarantee covers them. Perform writes exactly the entry
// it is returned; it does not assume that is the only one.
package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
)

// Pool is what Perform needs from a connection pool: the two replay lookups,
// which run outside the transaction, and the ability to open one.
//
// Declared here rather than taking *pgxpool.Pool, because that is what the
// neighbouring kernel packages do — idempotency.Querier and audit.Execer are
// both locally-declared subsets — and what §8 means by declaring the interface
// where it is consumed. *pgxpool.Pool satisfies it, and so does a fake, which
// is what makes the racing-peer branches below testable without inventing a
// race.
//
// The method signatures are pgx's own. Go matches interface methods exactly,
// so a locally-declared stand-in for pgx.Tx would be satisfied by nothing.
type Pool interface {
	idempotency.Querier
	Begin(ctx context.Context) (pgx.Tx, error)
}

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
// connection. Its type is the locally-declared Pool, matching what audit and
// idempotency already do and what module boundaries §8 asks for: declare the
// interface where it is consumed.
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
func Perform(ctx context.Context, pool Pool, key *idempotency.Key, op Operation) (Result, error) {
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
