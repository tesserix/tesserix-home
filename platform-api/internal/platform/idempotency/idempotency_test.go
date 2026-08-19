package idempotency_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

func requestWith(key string, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/v1/tickets/x/replies", strings.NewReader(body))
	if key != "" {
		r.Header.Set(idempotency.Header, key)
	}
	return r
}

func TestAnAbsentHeaderIsNotAnError(t *testing.T) {
	// Optional, deliberately. Requiring a key would have broken every caller
	// on the day this shipped, the console included.
	key, asked, err := idempotency.FromRequest(requestWith("", "{}"), "sub-1", "tickets.reply", []byte("{}"))

	if err != nil {
		t.Fatalf("an absent header must not be an error: %v", err)
	}
	if asked {
		t.Error("a request with no header did not ask for idempotency")
	}
	if key.Value != "" {
		t.Errorf("a key was built from nothing: %+v", key)
	}
}

func TestAnUnusableHeaderIsAnErrorRatherThanSilentlyIgnored(t *testing.T) {
	// The distinction that matters: a caller who MEANT to be idempotent and
	// got the header wrong must be told. Treating it as absent would perform
	// the write and let them believe it was protected.
	for name, raw := range map[string]string{
		"too long":          strings.Repeat("k", 256),
		"control character": "abc\ndef",
		"a space":           "abc def",
		"non-ascii":         "ключ",
	} {
		_, asked, err := idempotency.FromRequest(requestWith(raw, "{}"), "sub-1", "tickets.reply", []byte("{}"))

		if !asked {
			t.Errorf("%s: the caller sent a header and must be treated as having asked", name)
		}
		if !errors.Is(err, idempotency.ErrInvalidKey) {
			t.Errorf("%s: err = %v, want ErrInvalidKey", name, err)
		}
	}
}

func TestTheDigestIsOfTheBodyAndNotTheBody(t *testing.T) {
	// A reply's text is the merchant's conversation. Storing it here would put
	// a second copy beside the one that already exists, with a different
	// retention and a wider read grant.
	secret := []byte(`{"content":"card ending 4242 was double charged"}`)

	key, _, err := idempotency.FromRequest(requestWith("k1", string(secret)), "sub-1", "tickets.reply", secret)
	if err != nil {
		t.Fatalf("FromRequest: %v", err)
	}
	if strings.Contains(key.Digest, "4242") || strings.Contains(key.Digest, "charged") {
		t.Errorf("the body leaked into the digest: %q", key.Digest)
	}
	if len(key.Digest) != 64 {
		t.Errorf("digest = %q, want a 64-character sha256 hex", key.Digest)
	}
}

func TestDifferentBodiesDigestDifferently(t *testing.T) {
	first, _, _ := idempotency.FromRequest(requestWith("k1", "a"), "sub-1", "tickets.reply", []byte(`{"content":"a"}`))
	second, _, _ := idempotency.FromRequest(requestWith("k1", "b"), "sub-1", "tickets.reply", []byte(`{"content":"b"}`))

	if first.Digest == second.Digest {
		t.Error("two different bodies produced the same digest; the reuse check cannot work")
	}
}

// ---- against a real database -------------------------------------------

func newKey(t *testing.T, value, principal, operation, body string) idempotency.Key {
	t.Helper()
	key, _, err := idempotency.FromRequest(requestWith(value, body), principal, operation, []byte(body))
	if err != nil {
		t.Fatalf("FromRequest: %v", err)
	}
	return key
}

func TestANewKeyLooksUpAsAbsent(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	stored, err := Lookup(ctx, pool, newKey(t, "k1", "sub-1", "tickets.reply", `{"content":"hi"}`))
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if stored != nil {
		t.Errorf("a key never recorded came back as %+v", stored)
	}
}

func TestARetryGetsTheOriginalResponseVerbatim(t *testing.T) {
	// Verbatim is the point. A retry that got 200 with a different body would
	// leave the client believing something changed on the second call.
	pool := testdb.New(t)
	ctx := context.Background()
	key := newKey(t, "k1", "sub-1", "tickets.reply", `{"content":"hi"}`)
	original := []byte(`{"success":true,"data":{"reply":{"id":"r-1"}}}`)

	recorded, err := idempotency.Record(ctx, pool, key, http.StatusCreated, original)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if !recorded {
		t.Fatal("the first Record must claim the key")
	}

	stored, err := Lookup(ctx, pool, key)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if stored == nil {
		t.Fatal("the recorded key came back absent")
	}
	if stored.Status != http.StatusCreated {
		t.Errorf("status = %d, want 201", stored.Status)
	}
	if string(stored.Body) != string(original) {
		t.Errorf("body = %s, want it replayed verbatim", stored.Body)
	}
}

func TestTheSameKeyWithADifferentBodyIsRefused(t *testing.T) {
	// The dangerous case, and the reason the digest is stored. Replaying the
	// first response here would silently discard the second request.
	pool := testdb.New(t)
	ctx := context.Background()
	first := newKey(t, "k1", "sub-1", "tickets.reply", `{"content":"first"}`)
	second := newKey(t, "k1", "sub-1", "tickets.reply", `{"content":"SECOND, quite different"}`)

	if _, err := idempotency.Record(ctx, pool, first, http.StatusCreated, []byte(`{}`)); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if _, err := Lookup(ctx, pool, second); !errors.Is(err, idempotency.ErrKeyReused) {
		t.Errorf("err = %v, want ErrKeyReused", err)
	}
}

func TestTheSameKeyAtADifferentOperationIsRefused(t *testing.T) {
	// Otherwise a key minted for a reply could replay a reply's stored
	// response at the status endpoint.
	pool := testdb.New(t)
	ctx := context.Background()
	body := `{"x":1}`
	reply := newKey(t, "k1", "sub-1", "tickets.reply", body)
	status := newKey(t, "k1", "sub-1", "tickets.status", body)

	if _, err := idempotency.Record(ctx, pool, reply, http.StatusCreated, []byte(`{}`)); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if _, err := Lookup(ctx, pool, status); !errors.Is(err, idempotency.ErrKeyReused) {
		t.Errorf("err = %v, want ErrKeyReused", err)
	}
}

func TestOnePrincipalsKeyIsInvisibleToAnother(t *testing.T) {
	// Without the principal in the identity, a key is a guessable handle onto
	// somebody else's stored response — and stored responses contain ticket
	// content.
	pool := testdb.New(t)
	ctx := context.Background()
	body := `{"content":"internal note"}`
	mine := newKey(t, "shared-key", "sub-1", "tickets.reply", body)
	theirs := newKey(t, "shared-key", "sub-2", "tickets.reply", body)

	if _, err := idempotency.Record(ctx, pool, mine, http.StatusCreated, []byte(`{"secret":true}`)); err != nil {
		t.Fatalf("Record: %v", err)
	}

	stored, err := Lookup(ctx, pool, theirs)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if stored != nil {
		t.Errorf("principal sub-2 read sub-1's stored response: %s", stored.Body)
	}
}

func TestASecondRecordOfTheSameKeyReportsTheLoss(t *testing.T) {
	// The concurrency path. The loser must be told, so it can roll back its
	// duplicate write rather than committing it alongside the winner's.
	pool := testdb.New(t)
	ctx := context.Background()
	key := newKey(t, "k1", "sub-1", "tickets.reply", `{"content":"hi"}`)

	won, err := idempotency.Record(ctx, pool, key, http.StatusCreated, []byte(`{"first":true}`))
	if err != nil || !won {
		t.Fatalf("first Record: won=%v err=%v", won, err)
	}

	won, err = idempotency.Record(ctx, pool, key, http.StatusCreated, []byte(`{"second":true}`))
	if err != nil {
		t.Fatalf("second Record: %v", err)
	}
	if won {
		t.Error("the second Record claimed a key that was already taken")
	}
}

func TestTheLosersResponseDoesNotOverwriteTheWinners(t *testing.T) {
	// ON CONFLICT DO NOTHING, not DO UPDATE. The stored response must be the
	// one whose write actually committed.
	pool := testdb.New(t)
	ctx := context.Background()
	key := newKey(t, "k1", "sub-1", "tickets.reply", `{"content":"hi"}`)

	_, _ = idempotency.Record(ctx, pool, key, http.StatusCreated, []byte(`{"winner":true}`))
	_, _ = idempotency.Record(ctx, pool, key, http.StatusOK, []byte(`{"loser":true}`))

	stored, err := Lookup(ctx, pool, key)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if string(stored.Body) != `{"winner":true}` || stored.Status != http.StatusCreated {
		t.Errorf("stored = %d %s, want the first attempt's response", stored.Status, stored.Body)
	}
}

func TestARolledBackWriteLeavesNoKeyBehind(t *testing.T) {
	// The ordering guarantee, asserted directly: a key in the table always
	// corresponds to a committed write. If Record could outlive its
	// transaction, the retry of a request that never landed would be refused.
	pool := testdb.New(t)
	ctx := context.Background()
	key := newKey(t, "k1", "sub-1", "tickets.reply", `{"content":"hi"}`)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if _, err := idempotency.Record(ctx, tx, key, http.StatusCreated, []byte(`{}`)); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("Rollback: %v", err)
	}

	stored, err := Lookup(ctx, pool, key)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if stored != nil {
		t.Error("a rolled-back write left its idempotency key behind; a retry would now be refused")
	}
}

// Lookup is called through this shim so the tests read against pgx's own
// types without each one restating the interface.
func Lookup(ctx context.Context, q idempotency.Querier, key idempotency.Key) (*idempotency.Stored, error) {
	return idempotency.Lookup(ctx, q, key)
}

var _ idempotency.Querier = (pgx.Tx)(nil)
