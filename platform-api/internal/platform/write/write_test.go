package write_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/write"
)

// The interface exists so this package can be driven by a fake; it would be
// worthless if the real pool no longer satisfied it, and that is a compile
// error rather than a test failure.
var _ write.Pool = (*pgxpool.Pool)(nil)

// ---- helpers ------------------------------------------------------------

func keyFor(t *testing.T, value string) *idempotency.Key {
	t.Helper()
	r, err := http.NewRequest(http.MethodPost, "/v1/things", nil)
	if err != nil {
		t.Fatalf("building a request: %v", err)
	}
	r.Header.Set(idempotency.Header, value)
	key, asked, err := idempotency.FromRequest(r, "sub-1", "tickets.reply", []byte(`{"a":1}`))
	if err != nil || !asked {
		t.Fatalf("FromRequest(%q): asked=%v err=%v", value, asked, err)
	}
	return &key
}

func entry(action string) audit.Entry {
	return audit.Entry{Actor: "sub-1", Action: action, Target: "thing-1"}
}

func counts(t *testing.T, pool *pgxpool.Pool) (audits, keys int) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM console_audit_log`).Scan(&audits); err != nil {
		t.Fatalf("counting audit rows: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM platform_api_idempotency`).Scan(&keys); err != nil {
		t.Fatalf("counting idempotency rows: %v", err)
	}
	return audits, keys
}

// markerRow is a row the OPERATION writes on its own transaction, using the
// escape hatch the package comment documents. Its presence or absence after
// Perform returns is what proves a rollback covered the operation's work and
// not merely the parts Perform writes itself.
func markerRow(ctx context.Context, tx pgx.Tx) error {
	return audit.Write(ctx, tx, entry("tickets.marker"))
}

// ---- the happy path, so the failures below mean something ----------------

func TestAWriteItsAuditRowAndItsKeyAllLand(t *testing.T) {
	pool := testdb.New(t)
	key := keyFor(t, "k-happy")

	got, err := write.Perform(context.Background(), pool, key,
		func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
			return map[string]int{"n": 1}, entry("tickets.reply"), http.StatusCreated, nil
		})
	if err != nil {
		t.Fatalf("Perform: %v", err)
	}

	if got.Status != http.StatusCreated || string(got.Body) != `{"n":1}` {
		t.Errorf("result = %+v", got)
	}
	if audits, keys := counts(t, pool); audits != 1 || keys != 1 {
		t.Errorf("audits = %d, keys = %d, want 1 and 1", audits, keys)
	}
}

func TestARetryReplaysWithoutRunningTheOperationAgain(t *testing.T) {
	// The replay lookup runs outside the transaction and before the work, so
	// a retry must not reach the operation at all.
	pool := testdb.New(t)
	key := keyFor(t, "k-retry")
	ctx := context.Background()

	first, err := write.Perform(ctx, pool, key,
		func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
			return map[string]int{"n": 1}, entry("tickets.reply"), http.StatusCreated, nil
		})
	if err != nil {
		t.Fatalf("the first attempt: %v", err)
	}

	ran := false
	second, err := write.Perform(ctx, pool, key,
		func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
			ran = true
			return map[string]int{"n": 2}, entry("tickets.reply"), http.StatusCreated, nil
		})
	if err != nil {
		t.Fatalf("the retry: %v", err)
	}

	if ran {
		t.Error("the retry ran the operation again")
	}
	if second.Status != first.Status || string(second.Body) != string(first.Body) {
		t.Errorf("retry = %+v, first = %+v", second, first)
	}
	if audits, _ := counts(t, pool); audits != 1 {
		t.Errorf("audit rows = %d, want 1 — the retry audited a second time", audits)
	}
}

// ---- the operation's error reaches the caller unchanged -----------------

var errRefused = errors.New("the request was refused")

func TestAnOperationsErrorIsReturnedUnwrapped(t *testing.T) {
	// The module's handler distinguishes a refusal (422) from a malformed
	// request (400) with errors.Is. Wrapping the operation's error here — with
	// "performing a write: %w" or anything else — would still satisfy
	// errors.Is, but returning a NEW error would not, and this is the test
	// that notices.
	pool := testdb.New(t)

	_, err := write.Perform(context.Background(), pool, keyFor(t, "k-refused"),
		func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
			return nil, audit.Entry{}, 0, errRefused
		})

	if !errors.Is(err, errRefused) {
		t.Fatalf("err = %v, want the operation's own error", err)
	}
	if audits, keys := counts(t, pool); audits != 0 || keys != 0 {
		t.Errorf("a refused write left rows behind: audits = %d, keys = %d", audits, keys)
	}
}

// ---- the three branches nothing else binds ------------------------------

func TestAPayloadThatCannotBeEncodedRollsTheWriteBack(t *testing.T) {
	// Marshalling happens inside the transaction on purpose: the stored replay
	// body must be the bytes the first caller received. The consequence, which
	// is what this test pins, is that a payload that cannot be encoded takes
	// the operation's already-executed work down with it.
	pool := testdb.New(t)

	_, err := write.Perform(context.Background(), pool, keyFor(t, "k-marshal"),
		func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
			if err := markerRow(ctx, tx); err != nil {
				return nil, audit.Entry{}, 0, err
			}
			// A channel is not JSON, and never will be.
			return map[string]any{"c": make(chan int)}, entry("tickets.reply"), http.StatusCreated, nil
		})

	if err == nil {
		t.Fatal("an unencodable payload was accepted")
	}
	var unsupported *json.UnsupportedTypeError
	if !errors.As(err, &unsupported) {
		t.Errorf("err = %v, want the encoding failure", err)
	}
	if audits, keys := counts(t, pool); audits != 0 || keys != 0 {
		t.Errorf("the operation's work survived a failed encode: audits = %d, keys = %d", audits, keys)
	}
}

func TestAnUnauditableOperationDoesNotProceed(t *testing.T) {
	// ADR-003 D2a's guarantee, structurally: the audit INSERT runs on the
	// operation's own transaction, so a refused audit row rolls the work back
	// rather than leaving a write nobody recorded.
	pool := testdb.New(t)

	_, err := write.Perform(context.Background(), pool, keyFor(t, "k-unauditable"),
		func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
			if err := markerRow(ctx, tx); err != nil {
				return nil, audit.Entry{}, 0, err
			}
			// Prose, which audit refuses.
			return map[string]int{"n": 1}, entry("Replied to a ticket"), http.StatusCreated, nil
		})

	if err == nil {
		t.Fatal("an unauditable operation was allowed to proceed")
	}
	if audits, keys := counts(t, pool); audits != 0 || keys != 0 {
		t.Errorf("an unauditable operation left rows: audits = %d, keys = %d", audits, keys)
	}
}

func TestAConcurrentClaimLoserReplaysTheWinnersBody(t *testing.T) {
	// The race, made deterministic without weakening anything. The operation
	// runs on Perform's transaction; from inside it, a SEPARATE connection —
	// the pool — claims the same key and commits, exactly as a racing peer
	// would. Perform's own Record then finds the key taken.
	pool := testdb.New(t)
	key := keyFor(t, "k-race")
	ctx := context.Background()

	winner := []byte(`{"winner":true}`)

	got, err := write.Perform(ctx, pool, key,
		func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
			if err := markerRow(ctx, tx); err != nil {
				return nil, audit.Entry{}, 0, err
			}
			won, err := idempotency.Record(ctx, pool, *key, http.StatusOK, winner)
			if err != nil {
				return nil, audit.Entry{}, 0, err
			}
			if !won {
				return nil, audit.Entry{}, 0, errors.New("the peer failed to claim the key")
			}
			return map[string]bool{"winner": false}, entry("tickets.reply"), http.StatusCreated, nil
		})
	if err != nil {
		t.Fatalf("Perform: %v", err)
	}

	if got.Status != http.StatusOK || string(got.Body) != string(winner) {
		t.Errorf("result = %+v, want the winner's %d and %s", got, http.StatusOK, winner)
	}
	// The loser's work — its marker row included — must be gone. The only
	// idempotency row is the winner's, written on the other connection.
	if audits, keys := counts(t, pool); audits != 0 || keys != 1 {
		t.Errorf("the loser's work survived: audits = %d (want 0), keys = %d (want 1)", audits, keys)
	}
}

// ---- the branch that only a fake can reach ------------------------------

func TestAKeyClaimedByARequestThatLeftNoResponseIsReported(t *testing.T) {
	// Record and the commit share a transaction, so a key claimed by a request
	// that stored nothing cannot arise through this code path — real SQL will
	// not produce it. It is guarded anyway, because an unexplained state must
	// be reported rather than retried into a loop, and a fake is the only
	// honest way to stand in that state without weakening the guarantee that
	// makes it unreachable.
	tx := &fakeTx{}
	pool := &fakePool{tx: tx}

	_, err := write.Perform(context.Background(), pool, keyFor(t, "k-ghost"),
		func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
			return map[string]int{"n": 1}, entry("tickets.reply"), http.StatusCreated, nil
		})

	if err == nil {
		t.Fatal("a key with no stored response was accepted")
	}
	if !tx.rolledBack {
		t.Error("the loser's transaction was not rolled back")
	}
	if tx.committed {
		t.Error("the loser's transaction was committed")
	}
	if pool.lookups != 2 {
		t.Errorf("pool lookups = %d, want 2 — before the work and again after losing", pool.lookups)
	}
}

// fakePool answers every lookup with "no such key". The first one lets the
// work proceed; the second is the one that produces the guarded state.
type fakePool struct {
	tx      *fakeTx
	lookups int
}

func (p *fakePool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	p.lookups++
	return noRow{}
}

func (p *fakePool) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("write: the fake pool is not a transaction")
}

func (p *fakePool) Begin(ctx context.Context) (pgx.Tx, error) { return p.tx, nil }

type noRow struct{}

func (noRow) Scan(dest ...any) error { return pgx.ErrNoRows }

// fakeTx accepts the audit INSERT and reports the idempotency INSERT as having
// hit the conflict — which is what "a concurrent request committed first"
// looks like from here. pgx.Tx is embedded, and nil: any method this package
// does not use is a panic rather than a silent success, so the fake cannot
// quietly cover a call the test did not intend.
type fakeTx struct {
	pgx.Tx
	rolledBack bool
	committed  bool
}

func (t *fakeTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("INSERT 0 0"), nil
}

func (t *fakeTx) Rollback(ctx context.Context) error { t.rolledBack = true; return nil }

func (t *fakeTx) Commit(ctx context.Context) error { t.committed = true; return nil }
