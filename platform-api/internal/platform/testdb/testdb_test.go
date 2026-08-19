package testdb_test

import (
	"context"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// The helper's own test. It exists because every other database test in this
// service trusts it: if the migrations silently stopped being applied, every
// query test would fail with an unrelated "relation does not exist" and the
// cause would be three packages away.
func TestTheSchemaTheModulesNeedIsPresent(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	for _, table := range []string{
		"platform_tickets",
		"platform_ticket_replies",
		"console_audit_log",
		"platform_api_idempotency",
	} {
		var present bool
		err := pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables
			                 WHERE table_schema = 'public' AND table_name = $1)`,
			table,
		).Scan(&present)
		if err != nil {
			t.Fatalf("%s: %v", table, err)
		}
		if !present {
			t.Errorf("%s is missing; the migrations did not apply", table)
		}
	}
}

func TestEachTestGetsItsOwnEmptyDatabase(t *testing.T) {
	// The property that lets these tests run under -race without a truncate
	// step between them.
	pool := testdb.New(t)

	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM platform_tickets`).Scan(&count); err != nil {
		t.Fatalf("counting: %v", err)
	}
	if count != 0 {
		t.Errorf("a fresh database held %d tickets; it is being shared", count)
	}
}

func TestTheSequenceTicketNumbersAreMintedFromExists(t *testing.T) {
	// platform_tickets_seq is created by migration 0002 and is not a table, so
	// the table check above would not catch its absence — and a module that
	// cannot mint a ticket number cannot create a ticket.
	pool := testdb.New(t)

	var next int64
	if err := pool.QueryRow(context.Background(), `SELECT nextval('platform_tickets_seq')`).Scan(&next); err != nil {
		t.Fatalf("platform_tickets_seq: %v", err)
	}
	if next < 1 {
		t.Errorf("nextval = %d", next)
	}
}
