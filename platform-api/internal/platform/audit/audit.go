// Package audit writes the platform API's record of what a principal DID.
// Kernel, not a module — every module that mutates uses it, and it depends on
// no module.
//
// # Where auditing lives, which #269 asks to be decided rather than discovered
//
// The console audits its own writes today, through auditedOperation, against
// its own pool. The obvious risk once a Go module starts writing the same
// tables is two half-trails: some ticket writes recorded by the console, some
// by the API, neither complete.
//
// The rule this module establishes: **the writer audits.** Whoever performs
// the mutation records it, in the same transaction, and nobody audits a write
// somebody else performed. Under ADR-003 D7 each domain ends up with exactly
// one writer, so exactly one trail — and during a migration the boundary is
// unambiguous, because "did I write this row" is a question a caller can
// always answer. The alternative rule, "the console audits everything it
// triggers", cannot survive a product calling the API directly: a service
// principal filing a ticket never goes near the console, and its write would
// be unrecorded.
//
// # One transaction, which is where the guarantee comes from
//
// The console's auditedOperation guarantees that an unauditable operation does
// not proceed, and ADR-003 D2a cites that guarantee as a reason not to split
// the modules into services. Here it is simpler than the console's version:
// the audit INSERT runs on the caller's transaction, so a failed audit rolls
// the operation back by construction rather than by an ordering the caller has
// to get right. There is no window in which the write has landed and the
// record has not.
//
// # It is the same table the console writes
//
// console_audit_log, not a second store. Migration 0018 argues at length that
// operator-action audit is platform-owned and belongs in this database, and
// that #158's timeline is an aggregating READER over each source rather than a
// copy of them. A platform-api-specific table would make this service a second
// source for the same events and give the timeline two rows per action.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// The two patterns are copied from apps/console/lib/db/audit-repo.ts, where
// they are already documented. They must agree: the column is the one a
// retention or alerting rule discriminates on, and a rule written against the
// console's rows has to match the API's too.
var (
	actionName = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,63}$`)
	summaryKey = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,39}$`)
)

// Execer is the subset of pgx a write needs. Deliberately narrower than a full
// Querier: this package only ever inserts.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Entry is one audited action.
type Entry struct {
	// Actor is the principal's Zitadel subject — an opaque string, not a uuid.
	// The same value the console records, so one timeline can attribute both.
	Actor string
	// Action is a stable dotted identifier, e.g. "tickets.reply". Not prose:
	// migration 0018 names this as the column a retention or alerting rule
	// discriminates on, and prose cannot be discriminated on.
	Action string
	// Target is what was acted on. For this module, the ticket's id.
	Target string
	// Summary is counts only, never content. An audit trail that copies the
	// data it exists to account for is a second copy of the problem, with a
	// longer retention and a wider read grant than the original.
	Summary map[string]int
	// OccurredAt is the instant of the OPERATION, not of the insert. Zero
	// means now. The distinction matters when a transaction is slow: the
	// recorded instant should be when the thing happened.
	OccurredAt time.Time
}

// Write records one action on the caller's transaction.
//
// It MUST be handed the transaction that performs the operation — see the
// package comment. Handing it a pool would record an action that may still
// roll back, which is the failure this design exists to make impossible.
//
// Validation happens before the insert and its failures are distinct from a
// database error, because they are bugs in the caller rather than faults of
// the database, and reporting them as "the write failed" would send someone
// looking at Postgres.
func Write(ctx context.Context, db Execer, entry Entry) error {
	if !actionName.MatchString(entry.Action) {
		return fmt.Errorf(
			"audit: action %q is not a stable dotted identifier (e.g. \"tickets.reply\"); "+
				"this is the column a retention or alerting rule discriminates on, not free prose",
			entry.Action)
	}
	if entry.Actor == "" {
		// An unattributed row is not an audit trail. Every caller here is
		// behind authentication, so an empty actor is a wiring bug.
		return fmt.Errorf("audit: action %q has no actor", entry.Action)
	}

	metadata, err := serialiseSummary(entry.Summary)
	if err != nil {
		return err
	}

	occurredAt := entry.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}

	// target is NULL rather than "" when absent: the column is nullable
	// precisely because not every action has one, and an empty string is a
	// value that sorts and compares as if it were a target.
	var target any
	if entry.Target != "" {
		target = entry.Target
	}

	if _, err := db.Exec(ctx,
		`INSERT INTO console_audit_log (actor, action, target, occurred_at, metadata)
		 VALUES ($1, $2, $3, $4, $5)`,
		entry.Actor, entry.Action, target, occurredAt, metadata,
	); err != nil {
		return fmt.Errorf("audit: writing %q: %w", entry.Action, err)
	}
	return nil
}

// serialiseSummary validates and renders the summary, matching the console's
// serialiseSummary exactly — including its refusal to sanitise.
//
// Rejecting rather than dropping the offending key: a summary that tried to
// carry a row is a bug in the caller's summariser, and quietly removing it
// would leave the bug in place while producing an audit row that looks fine.
//
// Keys are sorted so the same summary always serialises identically, which is
// what lets two rows recording the same outcome compare equal as text. The
// column is text rather than jsonb (migration 0018: AuditLogViewer's metadata
// is a string), so text equality is the only comparison available.
func serialiseSummary(summary map[string]int) (any, error) {
	if len(summary) == 0 {
		// NULL, not "{}". The column is nullable and "no summary" is not the
		// same fact as "a summary containing nothing".
		return nil, nil
	}
	for _, key := range slices.Sorted(maps.Keys(summary)) {
		if !summaryKey.MatchString(key) {
			return nil, fmt.Errorf(
				"audit: summary key %q is not an identifier; "+
					"metadata carries counts, never result content", key)
		}
		if summary[key] < 0 {
			return nil, fmt.Errorf("audit: summary value for %q must be a non-negative count, got %d", key, summary[key])
		}
	}

	// Rendered by hand in sorted key order rather than through a map, because
	// encoding/json sorts map keys but says so nowhere it promises to keep
	// doing — and the identical-text property above depends on it.
	rendered := []byte("{")
	for i, key := range slices.Sorted(maps.Keys(summary)) {
		if i > 0 {
			rendered = append(rendered, ',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, fmt.Errorf("audit: encoding summary key %q: %w", key, err)
		}
		rendered = append(rendered, encodedKey...)
		rendered = append(rendered, ':')
		rendered = append(rendered, fmt.Appendf(nil, "%d", summary[key])...)
	}
	return string(append(rendered, '}')), nil
}
