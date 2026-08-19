package audit_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

type row struct {
	actor      string
	action     string
	target     *string
	occurredAt time.Time
	metadata   *string
}

func only(t *testing.T, pool *pgxpool.Pool) row {
	t.Helper()
	var r row
	err := pool.QueryRow(context.Background(),
		`SELECT actor, action, target, occurred_at, metadata FROM console_audit_log`,
	).Scan(&r.actor, &r.action, &r.target, &r.occurredAt, &r.metadata)
	if err != nil {
		t.Fatalf("reading the audit row: %v", err)
	}
	return r
}

func TestAnActionIsRecorded(t *testing.T) {
	pool := testdb.New(t)

	err := audit.Write(context.Background(), pool, audit.Entry{
		Actor:  "zitadel-sub-1",
		Action: "tickets.reply",
		Target: "3f2a1c94-0000-4000-8000-000000000001",
	})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	got := only(t, pool)
	if got.actor != "zitadel-sub-1" || got.action != "tickets.reply" {
		t.Errorf("row = %+v", got)
	}
	if got.target == nil || *got.target != "3f2a1c94-0000-4000-8000-000000000001" {
		t.Errorf("target = %v", got.target)
	}
}

func TestProseIsRefusedAsAnAction(t *testing.T) {
	// Migration 0018 names `action` as the column a retention or alerting rule
	// discriminates on. A rule cannot discriminate on prose.
	for _, action := range []string{
		"Replied to a ticket",
		"tickets.Reply",
		"tickets reply",
		"",
		"1tickets.reply",
		strings.Repeat("a", 65),
	} {
		err := audit.Write(context.Background(), nil, audit.Entry{Actor: "sub-1", Action: action})
		if err == nil {
			t.Errorf("action %q was accepted", action)
		}
	}
}

func TestAnActionRefusedForItsNameNeverReachesTheDatabase(t *testing.T) {
	// Passing a nil Execer above only proves it did not get that far by
	// accident. This proves it against a real one.
	pool := testdb.New(t)

	if err := audit.Write(context.Background(), pool, audit.Entry{Actor: "sub-1", Action: "Replied!"}); err == nil {
		t.Fatal("a malformed action was accepted")
	}

	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM console_audit_log`).Scan(&count); err != nil {
		t.Fatalf("counting: %v", err)
	}
	if count != 0 {
		t.Error("a rejected action still wrote a row")
	}
}

func TestAnUnattributedActionIsRefused(t *testing.T) {
	// A row with no actor is not an audit trail. Every caller is behind
	// authentication, so this is a wiring bug rather than a user error.
	if err := audit.Write(context.Background(), nil, audit.Entry{Action: "tickets.reply"}); err == nil {
		t.Error("an action with no actor was accepted")
	}
}

func TestASummaryOfCountsIsStoredSorted(t *testing.T) {
	// Sorted so two rows recording the same outcome compare equal as text —
	// the only comparison available, since the column is text rather than
	// jsonb (migration 0018 explains why).
	pool := testdb.New(t)

	err := audit.Write(context.Background(), pool, audit.Entry{
		Actor:   "sub-1",
		Action:  "tickets.reply",
		Summary: map[string]int{"replies": 1, "attachments": 0, "status_changes": 1},
	})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	got := only(t, pool)
	if got.metadata == nil {
		t.Fatal("metadata is NULL")
	}
	want := `{"attachments":0,"replies":1,"status_changes":1}`
	if *got.metadata != want {
		t.Errorf("metadata = %s, want %s", *got.metadata, want)
	}
}

func TestASummaryCarryingContentIsRefusedRatherThanStripped(t *testing.T) {
	// The line migration 0018 draws. An audit trail that copies the data it
	// exists to account for is a second copy of the problem, with a longer
	// retention and a wider read grant than the original.
	//
	// Refused, not sanitised: a summary that tried to carry content is a bug
	// in the caller's summariser, and dropping the key would leave the bug in
	// place under a row that looks fine.
	pool := testdb.New(t)

	err := audit.Write(context.Background(), pool, audit.Entry{
		Actor:   "sub-1",
		Action:  "tickets.reply",
		Summary: map[string]int{"merchant@example.com": 1},
	})
	if err == nil {
		t.Fatal("a summary key that is not an identifier was accepted")
	}

	var count int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM console_audit_log`).Scan(&count)
	if count != 0 {
		t.Error("the rejected entry still wrote a row")
	}
}

func TestANegativeCountIsRefused(t *testing.T) {
	err := audit.Write(context.Background(), nil, audit.Entry{
		Actor:   "sub-1",
		Action:  "tickets.reply",
		Summary: map[string]int{"replies": -1},
	})
	if err == nil {
		t.Error("a negative count was accepted; a summary carries counts")
	}
}

func TestAnAbsentSummaryIsNullRatherThanAnEmptyObject(t *testing.T) {
	// "No summary" and "a summary containing nothing" are different facts, and
	// the column is nullable so both can be told apart.
	pool := testdb.New(t)

	if err := audit.Write(context.Background(), pool, audit.Entry{Actor: "sub-1", Action: "tickets.status"}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	if got := only(t, pool); got.metadata != nil {
		t.Errorf("metadata = %q, want NULL", *got.metadata)
	}
}

func TestAnAbsentTargetIsNullRatherThanEmpty(t *testing.T) {
	// An empty string is a value that sorts and compares as if it were a
	// target.
	pool := testdb.New(t)

	if err := audit.Write(context.Background(), pool, audit.Entry{Actor: "sub-1", Action: "tickets.status"}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	if got := only(t, pool); got.target != nil {
		t.Errorf("target = %q, want NULL", *got.target)
	}
}

func TestTheRecordedInstantIsTheOperationsNotTheInserts(t *testing.T) {
	// Migration 0018 is explicit: written by the application rather than
	// defaulted from now(), so the recorded instant is the operation's. The
	// distinction shows up when a transaction is slow.
	pool := testdb.New(t)
	happened := time.Date(2026, 8, 19, 9, 41, 2, 0, time.UTC)

	err := audit.Write(context.Background(), pool, audit.Entry{
		Actor:      "sub-1",
		Action:     "tickets.reply",
		OccurredAt: happened,
	})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	if got := only(t, pool).occurredAt; !got.Equal(happened) {
		t.Errorf("occurred_at = %s, want %s", got, happened)
	}
}

func TestAnUnauditableOperationDoesNotProceed(t *testing.T) {
	// The guarantee ADR-003 D2a cites as a reason not to split the modules
	// into services, asserted end to end.
	//
	// The audit insert runs on the caller's transaction, so a failed audit
	// rolls the operation back by construction — there is no window in which
	// the write has landed and the record has not. Simulated here by an audit
	// that fails on its own terms (a malformed action) inside a transaction
	// that has already done its work.
	pool := testdb.New(t)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO platform_tickets
		   (product_id, tenant_id, ticket_number, subject, description,
		    submitted_by_name, submitted_by_email)
		 VALUES ('mark8ly', gen_random_uuid(), 'M8-0001', 's', 'd', 'n', 'e@x.test')`,
	); err != nil {
		t.Fatalf("the operation: %v", err)
	}

	if err := audit.Write(ctx, tx, audit.Entry{Actor: "sub-1", Action: "Not An Identifier"}); err == nil {
		t.Fatal("the audit was expected to fail")
	}
	// What a caller does on an audit failure: abandon the operation.
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("Rollback: %v", err)
	}

	var tickets int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM platform_tickets`).Scan(&tickets); err != nil {
		t.Fatalf("counting: %v", err)
	}
	if tickets != 0 {
		t.Error("an unauditable operation was committed anyway")
	}
}
