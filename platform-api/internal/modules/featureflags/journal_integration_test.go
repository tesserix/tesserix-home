//go:build integration

package featureflags

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

const requestOne = "018f8f5b-1111-7111-8111-111111111111"
const requestTwo = "018f8f5b-2222-7222-8222-222222222222"

func TestJournalReservationReplayFenceAndAudit(t *testing.T) {
	j := journal{pool: testdb.New(t)}
	ctx := context.Background()
	r := change{Key: "team_accounts", Enabled: false, ExpectedRevision: strings.Repeat("a", 64), Reason: "Reviewed release control"}
	c, created, err := j.reserve(ctx, "requester", requestOne, r, 1)
	if err != nil || !created || c.State != "queued" || c.Actor != "requester" {
		t.Fatalf("reserve: %#v created=%v err=%v", c, created, err)
	}
	replay, created, err := j.reserve(ctx, "requester", requestOne, r, 1)
	if err != nil || created || replay.ID != c.ID {
		t.Fatalf("duplicate: %#v created=%v err=%v", replay, created, err)
	}
	r.Reason = "A conflicting release reason"
	if _, _, err := j.reserve(ctx, "requester", requestOne, r, 1); !errors.Is(err, errKeyReused) {
		t.Fatalf("conflicting idempotency key: %v", err)
	}
	if _, _, err := j.reserve(ctx, "another-operator", requestOne, r, 1); !errors.Is(err, errBusy) {
		t.Fatalf("actor isolation/fence: %v", err)
	}
	if _, err := j.dispatch(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := j.cancel(ctx, c, "canceling-operator"); err == nil {
		t.Fatal("canceled an already dispatched write")
	}
	if _, err := j.finish(ctx, c, "in_doubt", "OUTCOME_UNKNOWN", nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := j.reserve(ctx, "requester", requestTwo, r, 1); !errors.Is(err, errBusy) {
		t.Fatalf("unknown delivery released product fence: %v", err)
	}
	version := 2
	confirmed, err := j.finish(ctx, c, "succeeded", "CONFIRMED", &version)
	if err != nil || confirmed.State != "succeeded" || confirmed.ProviderVersion == nil || *confirmed.ProviderVersion != 2 {
		t.Fatalf("confirmation: %#v %v", confirmed, err)
	}
	var count int
	if err := j.pool.QueryRow(ctx, `SELECT count(*) FROM console_audit_log WHERE target=$1`, c.ID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("intent and outcomes not audited: count=%d err=%v", count, err)
	}
	if _, created, err := j.reserve(ctx, "requester", requestTwo, r, 2); err != nil || !created {
		t.Fatalf("terminal command did not release fence: %v", err)
	}
}

func TestCancelDispatchRaceHasExactlyOneWinner(t *testing.T) {
	j := journal{pool: testdb.New(t)}
	ctx := context.Background()
	c, _, err := j.reserve(ctx, "requester", requestOne, change{Key: "team_accounts", ExpectedRevision: strings.Repeat("a", 64), Reason: "Reviewed release control"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var dispatchErr, cancelErr error
	wg.Add(2)
	go func() { defer wg.Done(); _, dispatchErr = j.dispatch(ctx, c.ID) }()
	go func() { defer wg.Done(); _, cancelErr = j.cancel(ctx, c, "canceling-operator") }()
	wg.Wait()
	if (dispatchErr == nil) == (cancelErr == nil) {
		t.Fatalf("expected one winner: dispatch=%v cancel=%v", dispatchErr, cancelErr)
	}
	if dispatchErr != nil && !errors.Is(dispatchErr, pgx.ErrNoRows) {
		t.Fatalf("unexpected dispatch failure: %v", dispatchErr)
	}
	current, err := j.find(ctx, "requester", requestOne)
	if err != nil {
		t.Fatal(err)
	}
	if cancelErr == nil {
		if current.State != "failed" || current.Code != "CANCELED_BEFORE_DISPATCH" {
			t.Fatalf("cancellation not terminal: %#v", current)
		}
		var actor string
		if err := j.pool.QueryRow(ctx, `SELECT actor FROM console_audit_log WHERE target=$1 AND action='feature_flags.canceled'`, c.ID).Scan(&actor); err != nil || actor != "canceling-operator" {
			t.Fatalf("wrong cancellation audit actor: %q %v", actor, err)
		}
	} else if current.State != "dispatching" {
		t.Fatalf("dispatch not retained: %#v", current)
	}
}
