package repository

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
)

// ErrNotFound is returned for an opportunity that does not exist.
//
// A sentinel rather than a formatted string, because the handler answers 404
// for it and 500 for everything else, and a handler deciding that by matching
// on message text is one rewording away from turning a 404 into a 500.
var ErrNotFound = errors.New("opportunity not found")

// ErrProductRequired is returned when the opportunity exists, is REACHABLE,
// and still cannot be updated — because it is one of the grandfathered rows
// migration 0021 left behind.
//
// ============================ THE HAZARD ================================
//
// crm_opportunities carries a NOT VALID CHECK
// (0021_crm_opportunities_product_check_reinstated.sql):
//
//	stage IN ('new', 'contacted') OR product IS NOT NULL
//
// NOT VALID means the ~155 historical qualified/won/lost rows the lead
// backfill wrote were never scanned, so they sit in the table violating it.
// It does NOT mean they are exempt from it: Postgres evaluates a NOT VALID
// CHECK on the NEW ROW VERSION of every INSERT and every UPDATE. So an UPDATE
// that touches NEITHER `stage` NOR `product` — a bare `next_action_at` bump,
// exactly this write — still produces a new row version that fails the check,
// and ABORTS THE WHOLE TRANSACTION. Under write.Perform that transaction also
// holds the audit row and the idempotency record, so one grandfathered row
// takes all three down.
//
// # Why the guard in SetNextAction's WHERE clause is NOT redundant
//
// Read it twice before deleting it. It looks redundant — the statement sets
// neither column it names — and it is not. Without it, the statement is
// attempted, the constraint fires, and the caller gets a raw Postgres
// constraint-violation error through a 500. With it, the row simply does not
// match, nothing is attempted, the transaction stays alive, and this sentinel
// gets the caller a 422 that names the actual problem.
//
// The console does the same thing twice, by two different routes, and the
// comments on both say why: advanceContactClock (apps/console/lib/db/
// crm-repo.ts:934) carries the identical predicate in its WHERE so a clock
// bump cannot take an activity insert down with it, and setNextAction
// (crm-repo.ts:730) reads `stage, product FOR UPDATE` first and throws
// MissingProductError rather than let the constraint speak.
//
// # And why "the update succeeds" is not available here
//
// This write has no `product` argument to offer, and the CHECK can only be
// satisfied by supplying one in the same UPDATE. So there is no formulation of
// this statement that both leaves `product` alone and lands on a grandfathered
// row. Verified against a real Postgres, not reasoned: see
// TestABareUpdateOnAGrandfatheredRowReallyDoesAbort, which runs the unguarded
// statement and asserts it fails. What is achievable — and what this module
// therefore does — is that the transaction does not abort and the operator is
// told what to fix. The fix is supplying the product the deal has been missing
// since it was migrated, which is a visible, fixable state; a 500 is not.
//
// ========================================================================
var ErrProductRequired = errors.New("this opportunity was migrated without a product and cannot be updated until one is set")

// productGuard is the CHECK, restated as a row filter.
//
// One constant, referenced by the UPDATE, so the guard and the constraint
// cannot be edited apart. domain.RequiresProduct is the same rule in Go and is
// what the refusal message is derived from.
const productGuard = `(o.stage IN ('new', 'contacted') OR o.product IS NOT NULL)`

// SetNextAction schedules — or clears — an opportunity's next action, and
// returns the opportunity as it now stands.
//
// It takes a Querier so it runs on the CALLER's transaction: the audit row and
// the idempotency record are written on that same transaction by
// write.Perform, and this update must land or not land with them.
//
// `updated_at` is set explicitly. crm_opportunities has no BEFORE UPDATE
// trigger for it (migration 0019 declares a plain `DEFAULT now()` column), so
// a write that did not say so would leave the row claiming it was last touched
// when it was created.
func SetNextAction(ctx context.Context, db Querier, id string, action domain.NextAction) (domain.Opportunity, error) {
	// The organisation is joined in because an Opportunity carries its
	// organisation's name — the opportunity has no name of its own — and the
	// response must be the row as this write left it rather than a second
	// read that a concurrent write could have moved underneath.
	row := db.QueryRow(ctx,
		`UPDATE crm_opportunities o
		    SET next_action_at = $2, next_action_note = $3, updated_at = now()
		   FROM crm_organisations g
		  WHERE o.id = $1::uuid
		    AND g.id = o.organisation_id
		    AND `+productGuard+`
		RETURNING `+queueColumns, id, action.At, action.Note)

	opportunity, err := scanOpportunity(row)
	switch {
	case err == nil:
		return opportunity, nil
	case errors.Is(err, pgx.ErrNoRows):
		// Nothing matched, and there are two reasons that can happen. Which
		// one it was decides between 404 and 422, so it is asked rather than
		// guessed.
		return domain.Opportunity{}, diagnose(ctx, db, id)
	case isMalformedUUID(err):
		// A string that is not a uuid names no opportunity. Reported as
		// absence rather than as a driver failure, because 22P02 here is a
		// caller typing a bad id into a path, not a fault of the database —
		// and a 500 would send an operator looking at Postgres.
		return domain.Opportunity{}, ErrNotFound
	default:
		return domain.Opportunity{}, fmt.Errorf("scheduling the next action on %s: %w", id, err)
	}
}

// diagnose runs only on the failure path: it says WHY the guarded update
// matched nothing.
//
// Deliberately not a pre-read on the happy path. The console's setNextAction
// reads `FOR UPDATE` before its update; here the guard is in the statement
// itself, so the common case costs one round trip and this costs a second only
// when something has already gone wrong.
func diagnose(ctx context.Context, db Querier, id string) error {
	var stage string
	err := db.QueryRow(ctx,
		`SELECT stage::text FROM crm_opportunities WHERE id = $1::uuid`, id).Scan(&stage)
	switch {
	case errors.Is(err, pgx.ErrNoRows), err != nil && isMalformedUUID(err):
		return ErrNotFound
	case err != nil:
		return fmt.Errorf("reading opportunity %s: %w", id, err)
	}

	parsed, parseErr := domain.ParseStage(stage)
	if parseErr != nil {
		return fmt.Errorf("opportunity %s: %w", id, parseErr)
	}
	if domain.RequiresProduct(parsed) {
		return fmt.Errorf("%w (it is at stage %q)", ErrProductRequired, stage)
	}
	// The row exists, is not grandfathered, and still did not match. That is
	// the guard and the CHECK having drifted apart, which is a bug in this
	// package rather than anything a caller did — so it is reported loudly
	// instead of being folded into one of the two answers above.
	return fmt.Errorf("opportunity %s matched no update and no reason explains it; "+
		"the product guard and %s have drifted apart", id, "crm_opp_product_required_when_qualified")
}

// isMalformedUUID reports whether an error is Postgres's invalid_text_
// representation, which is what `$1::uuid` produces for a path segment that is
// not a uuid.
func isMalformedUUID(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}
