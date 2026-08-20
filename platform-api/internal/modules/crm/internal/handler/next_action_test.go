package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
)

// The module's one write, exercised through its real router, real verifier and
// a real database — the same rule the reads follow.

const nextActionPath = "/v1/crm/opportunities/"

// put sends the write. `key` is the Idempotency-Key header, or "" for none.
func (a *api) put(path, body, key string) response {
	a.t.Helper()
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set(idempotency.Header, key)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("PUT %s: response is not JSON: %v (%s)", path, err, out.raw)
	}
	return out
}

func (a *api) setNextAction(id, body, key string) response {
	return a.put(nextActionPath+id+"/next-action", body, key)
}

// opportunityRow is the three columns the assertions below care about.
func (a *api) opportunityRow(id string) (at *time.Time, note *string, updatedAt time.Time) {
	a.t.Helper()
	if err := a.pool.QueryRow(context.Background(),
		`SELECT next_action_at, next_action_note, updated_at FROM crm_opportunities WHERE id = $1::uuid`,
		id).Scan(&at, &note, &updatedAt); err != nil {
		a.t.Fatalf("reading opportunity %s: %v", id, err)
	}
	return at, note, updatedAt
}

type auditRow struct {
	actor    string
	action   string
	target   *string
	metadata *string
}

func (a *api) auditRows() []auditRow {
	a.t.Helper()
	rows, err := a.pool.Query(context.Background(),
		`SELECT actor, action, target, metadata FROM console_audit_log ORDER BY occurred_at, action`)
	if err != nil {
		a.t.Fatalf("reading the audit log: %v", err)
	}
	defer rows.Close()
	var out []auditRow
	for rows.Next() {
		var r auditRow
		if err := rows.Scan(&r.actor, &r.action, &r.target, &r.metadata); err != nil {
			a.t.Fatalf("reading an audit row: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		a.t.Fatalf("reading the audit log: %v", err)
	}
	return out
}

// grandfathered seeds one of the rows migration 0021 left behind: stage
// `qualified` with NO product.
//
// It CANNOT be a plain INSERT, and that is worth understanding before editing
// it. `crm_opp_product_required_when_qualified` is NOT VALID, which exempts
// the rows that were already in the table when it was added — it does not
// exempt new ones. Postgres evaluates it on every INSERT and every UPDATE from
// that point on, so an INSERT of a qualified/null-product row is refused
// exactly as an UPDATE of one is.
//
// So the fixture replays how production got here: drop the constraint, write
// the row, re-add it NOT VALID. That is migrations 0020 → the lead backfill →
// 0021 in three statements, which is precisely the sequence that produced the
// ~155 real rows this guards against.
func (a *api) grandfathered(org, label string) string {
	a.t.Helper()
	ctx := context.Background()
	orgID, ok := a.orgs[org]
	if !ok {
		a.t.Fatalf("grandfathered opportunity %q names organisation %q, which was never seeded", label, org)
	}

	if _, err := a.pool.Exec(ctx,
		`ALTER TABLE crm_opportunities DROP CONSTRAINT crm_opp_product_required_when_qualified`,
	); err != nil {
		a.t.Fatalf("dropping the product CHECK: %v", err)
	}
	var id string
	if err := a.pool.QueryRow(ctx,
		`INSERT INTO crm_opportunities
		   (organisation_id, product, stage, next_action_note, created_at)
		 VALUES ($1::uuid, NULL, 'qualified'::crm_stage, $2, $3)
		 RETURNING id::text`,
		orgID, label, a.base,
	).Scan(&id); err != nil {
		a.t.Fatalf("seeding grandfathered opportunity %q: %v", label, err)
	}
	if _, err := a.pool.Exec(ctx,
		`ALTER TABLE crm_opportunities
		   ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
		     stage IN ('new', 'contacted') OR product IS NOT NULL
		   ) NOT VALID`,
	); err != nil {
		a.t.Fatalf("re-adding the product CHECK: %v", err)
	}
	return id
}

// writeWorld is one organisation and one ordinary, updatable opportunity.
func writeWorld(t *testing.T) (*api, string) {
	a := serve(t)
	a.org(orgSpec{name: "Acme", country: ptr("AU"), contacts: []contactSpec{{primary: true, followers: ptr(4000)}}})
	id := a.opportunity(oppSpec{org: "Acme", label: "acme-mark8ly", product: ptr("mark8ly"),
		stage: domain.StageContacted, owner: ptr("Priya Raman"), nextActionAt: a.ago(2 * day)})
	return a, id
}

// ---- THE HAZARD ---------------------------------------------------------

// The load-bearing test. It runs the statement WITHOUT the guard, against a
// grandfathered row, and asserts it fails.
//
// It exists so nobody deletes repository's productGuard as redundant. The
// guard names `stage` and `product`; the UPDATE sets neither; every instinct
// says it cannot matter. It matters because a NOT VALID CHECK is evaluated on
// the NEW ROW VERSION of the update, not on the columns the update mentions —
// and this test is the proof, run against a real Postgres rather than argued
// from the manual.
//
// If this ever goes green, the constraint changed and the guard (and the 422
// beside it) can go. Until then it is the reason both exist.
func TestABareUpdateOnAGrandfatheredRowReallyDoesAbort(t *testing.T) {
	a, _ := writeWorld(t)
	id := a.grandfathered("Acme", "acme-migrated")

	_, err := a.pool.Exec(context.Background(),
		`UPDATE crm_opportunities SET next_action_at = now(), updated_at = now() WHERE id = $1::uuid`, id)

	if err == nil {
		t.Fatal("an unguarded UPDATE of a grandfathered row succeeded; " +
			"the CHECK is no longer enforced, so re-read repository.ErrProductRequired " +
			"before assuming the guard is still needed")
	}
	if !strings.Contains(err.Error(), "crm_opp_product_required_when_qualified") {
		t.Errorf("the update failed for an unexpected reason: %v", err)
	}
}

// The write's own behaviour on the same row: it must NOT abort. A 422 naming
// the missing product, not a 500 carrying a constraint name.
func TestAGrandfatheredRowIsRefusedRatherThanAbortingTheTransaction(t *testing.T) {
	a, _ := writeWorld(t)
	id := a.grandfathered("Acme", "acme-migrated")

	got := a.setNextAction(id, `{"at":"2026-09-01T09:00:00Z","note":"chase the contract"}`, "")

	if got.status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", got.status, got.raw)
	}
	if !strings.Contains(got.raw, "product") {
		t.Errorf("the refusal does not tell the operator what to fix: %s", got.raw)
	}
	if strings.Contains(got.raw, "crm_opp_product_required_when_qualified") {
		t.Errorf("a Postgres constraint name reached the client: %s", got.raw)
	}
	// Nothing landed — including no audit row. A refusal is not an action.
	if rows := a.auditRows(); len(rows) != 0 {
		t.Errorf("a refused write left %d audit rows: %+v", len(rows), rows)
	}
	at, _, _ := a.opportunityRow(id)
	if at != nil {
		t.Errorf("the refused write moved next_action_at to %v", at)
	}
}

// The transaction being alive rather than merely un-aborted: an ordinary write
// on the SAME connection pool, straight after the refusal, must still work.
// An aborted transaction that leaked would take this down with it.
func TestARefusalDoesNotPoisonTheNextWrite(t *testing.T) {
	a, ordinary := writeWorld(t)
	grandfathered := a.grandfathered("Acme", "acme-migrated")

	if got := a.setNextAction(grandfathered, `{"at":"2026-09-01T09:00:00Z"}`, ""); got.status != http.StatusUnprocessableEntity {
		t.Fatalf("the refusal did not happen: %d %s", got.status, got.raw)
	}

	got := a.setNextAction(ordinary, `{"at":"2026-09-02T09:00:00Z","note":"send the quote"}`, "")

	if got.status != http.StatusOK {
		t.Fatalf("the write after a refusal failed: %d %s", got.status, got.raw)
	}
	if rows := a.auditRows(); len(rows) != 1 {
		t.Errorf("audit rows = %d, want exactly the one successful write: %+v", len(rows), rows)
	}
}

// ---- the ordinary path --------------------------------------------------

func TestANextActionLandsWithItsAuditRow(t *testing.T) {
	a, id := writeWorld(t)

	got := a.setNextAction(id, `{"at":"2026-09-01T09:00:00Z","note":"send the quote"}`, "")

	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	at, note, updatedAt := a.opportunityRow(id)
	if at == nil || !at.UTC().Equal(time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("next_action_at = %v, want 2026-09-01T09:00:00Z", at)
	}
	if note == nil || *note != "send the quote" {
		t.Errorf("next_action_note = %v, want \"send the quote\"", note)
	}
	// crm_opportunities has no updated_at trigger, so the write sets it
	// explicitly — and if it ever stopped, the row would claim it was last
	// touched when it was created.
	if !updatedAt.After(a.base) {
		t.Errorf("updated_at = %v, want something after the fixture's %v", updatedAt, a.base)
	}

	rows := a.auditRows()
	if len(rows) != 1 {
		t.Fatalf("audit rows = %d, want 1: %+v", len(rows), rows)
	}
	if rows[0].action != "crm.next_action.set" {
		t.Errorf("action = %q, want \"crm.next_action.set\" — the console's own spelling for this write", rows[0].action)
	}
	if rows[0].actor != "operator@tesserix.test" {
		t.Errorf("actor = %q, want the operator's email", rows[0].actor)
	}
	if rows[0].target == nil || *rows[0].target != id {
		t.Errorf("target = %v, want the opportunity %s", rows[0].target, id)
	}
	// Counts only. The note is the operator's text and must not be here.
	if rows[0].metadata == nil || *rows[0].metadata != `{"scheduled":1}` {
		t.Errorf("metadata = %v, want {\"scheduled\":1}", rows[0].metadata)
	}
}

// Clearing is the same verb with the opposite argument, and it is audited as
// the same action with a count of zero rather than as a second action.
func TestClearingIsTheSameActionCountedAtZero(t *testing.T) {
	a, id := writeWorld(t)

	got := a.setNextAction(id, `{}`, "")

	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	at, note, _ := a.opportunityRow(id)
	if at != nil || note != nil {
		t.Errorf("the clear left next_action_at=%v note=%v", at, note)
	}
	rows := a.auditRows()
	if len(rows) != 1 || rows[0].action != "crm.next_action.set" {
		t.Fatalf("audit rows = %+v, want one crm.next_action.set", rows)
	}
	if rows[0].metadata == nil || *rows[0].metadata != `{"scheduled":0}` {
		t.Errorf("metadata = %v, want {\"scheduled\":0} — a clear is an outcome, not a no-op", rows[0].metadata)
	}
}

// A note of nothing but spaces is not a note. Storing one would put a blank
// reminder on a queue row where an operator expects text or nothing.
func TestAWhitespaceNoteIsStoredAsNoNote(t *testing.T) {
	a, id := writeWorld(t)

	if got := a.setNextAction(id, `{"at":"2026-09-01T09:00:00Z","note":"   "}`, ""); got.status != http.StatusOK {
		t.Fatalf("status = %d: %s", got.status, got.raw)
	}

	if _, note, _ := a.opportunityRow(id); note != nil {
		t.Errorf("next_action_note = %q, want NULL", *note)
	}
}

func TestAnOverLongNoteIsRefused(t *testing.T) {
	a, id := writeWorld(t)
	body, err := json.Marshal(map[string]any{"note": strings.Repeat("n", domain.MaxNextActionNoteLength+1)})
	if err != nil {
		t.Fatalf("building the body: %v", err)
	}

	got := a.setNextAction(id, string(body), "")

	if got.status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", got.status, got.raw)
	}
	// A domain refusal must not reach the database at all, so no audit row.
	if rows := a.auditRows(); len(rows) != 0 {
		t.Errorf("a refused write left %d audit rows", len(rows))
	}
}

// ---- idempotency --------------------------------------------------------

// The same key twice REPLAYS. Not "writes twice", and not "refuses": the
// second call is a retry of the first, and it must answer with what the first
// produced, verbatim.
func TestTheSameIdempotencyKeyReplaysRatherThanWritingTwice(t *testing.T) {
	a, id := writeWorld(t)
	body := `{"at":"2026-09-01T09:00:00Z","note":"send the quote"}`

	first := a.setNextAction(id, body, "k-1")
	second := a.setNextAction(id, body, "k-1")

	if first.status != http.StatusOK || second.status != first.status {
		t.Fatalf("statuses = %d then %d, want 200 twice: %s / %s",
			first.status, second.status, first.raw, second.raw)
	}
	// `data`, not the whole envelope. What is REPLAYED is the stored body —
	// the bytes the first caller received for the resource — while
	// `timestamp` and `request_id` are properties of THIS response and are
	// correctly different on the retry. Comparing the raw envelope would
	// assert that a retry is indistinguishable from the original request,
	// which it is not and should not be: an operator correlating logs needs
	// the retry to have its own request id.
	firstData, secondData := mustEncode(t, first.body["data"]), mustEncode(t, second.body["data"])
	if firstData != secondData {
		t.Errorf("the replay differed from the original.\nfirst:  %s\nsecond: %s", firstData, secondData)
	}
	// The point of the whole mechanism: ONE audit row for two calls. Two would
	// mean the write ran twice.
	if rows := a.auditRows(); len(rows) != 1 {
		t.Errorf("audit rows = %d, want 1 — the retry performed the write again: %+v", len(rows), rows)
	}
}

// No header is a NORMAL write, not a refusal — idempotency is optional, and
// requiring it would have broken every caller on the day it shipped.
func TestNoIdempotencyHeaderIsAnOrdinaryWrite(t *testing.T) {
	a, id := writeWorld(t)

	first := a.setNextAction(id, `{"at":"2026-09-01T09:00:00Z"}`, "")
	second := a.setNextAction(id, `{"at":"2026-09-03T09:00:00Z"}`, "")

	if first.status != http.StatusOK || second.status != http.StatusOK {
		t.Fatalf("statuses = %d then %d, want 200 twice", first.status, second.status)
	}
	if rows := a.auditRows(); len(rows) != 2 {
		t.Errorf("audit rows = %d, want 2 — an unkeyed write must not be deduplicated", len(rows))
	}
}

// The dangerous case: one key, two different bodies. Replaying the first
// response here would silently discard the second request.
func TestOneKeyWithTwoBodiesIsAConflict(t *testing.T) {
	a, id := writeWorld(t)

	if got := a.setNextAction(id, `{"at":"2026-09-01T09:00:00Z"}`, "k-1"); got.status != http.StatusOK {
		t.Fatalf("the first write failed: %d %s", got.status, got.raw)
	}
	got := a.setNextAction(id, `{"at":"2026-09-09T09:00:00Z"}`, "k-1")

	if got.status != http.StatusConflict {
		t.Errorf("status = %d, want 409: %s", got.status, got.raw)
	}
}

// ---- the refusals a client's error handling is written against ----------

func TestAMissingOpportunityIsAMappedSentinelNotA500(t *testing.T) {
	a, _ := writeWorld(t)

	got := a.setNextAction("11111111-1111-1111-1111-111111111111",
		`{"at":"2026-09-01T09:00:00Z"}`, "")

	if got.status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", got.status, got.raw)
	}
	if rows := a.auditRows(); len(rows) != 0 {
		t.Errorf("a 404 left %d audit rows", len(rows))
	}
}

// A path segment that is not a uuid names no opportunity. 404 rather than the
// 500 a raw `$1::uuid` cast failure would produce.
func TestAnIdThatIsNotAUUIDIsA404(t *testing.T) {
	a, _ := writeWorld(t)

	if got := a.setNextAction("not-a-uuid", `{"at":"2026-09-01T09:00:00Z"}`, ""); got.status != http.StatusNotFound {
		t.Errorf("status = %d, want 404: %s", got.status, got.raw)
	}
}

func TestAnUnknownBodyFieldIsRefused(t *testing.T) {
	a, id := writeWorld(t)

	got := a.setNextAction(id, `{"at":"2026-09-01T09:00:00Z","nte":"typo"}`, "")

	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — an unknown field must be told, not silently dropped: %s",
			got.status, got.raw)
	}
	if _, note, _ := a.opportunityRow(id); note == nil || *note != "acme-mark8ly" {
		t.Errorf("the refused body still changed the row: note = %v", note)
	}
}

func TestAnEmptyBodyIsRefused(t *testing.T) {
	a, id := writeWorld(t)

	if got := a.setNextAction(id, ``, ""); got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", got.status, got.raw)
	}
}

func TestADateThatIsNotRFC3339IsRefused(t *testing.T) {
	a, id := writeWorld(t)

	if got := a.setNextAction(id, `{"at":"next tuesday"}`, ""); got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// ---- the golden response ------------------------------------------------

func TestNextActionGoldenResponse(t *testing.T) {
	a, id := writeWorld(t)

	assertGolden(t, "next-action",
		a.setNextAction(id, `{"at":"2026-09-01T09:00:00Z","note":"send the quote"}`, "").raw)

	// The failures too: a client's error handling is exercised less than its
	// success path, so a change here is likelier to go unnoticed. The
	// grandfathered refusal in particular is the one an operator reads.
	assertGolden(t, "next-action-missing",
		a.setNextAction("11111111-1111-1111-1111-111111111111", `{"at":"2026-09-01T09:00:00Z"}`, "").raw)

	grandfathered := a.grandfathered("Acme", "acme-migrated")
	assertGolden(t, "next-action-product-required",
		a.setNextAction(grandfathered, `{"at":"2026-09-01T09:00:00Z"}`, "").raw)
}

// mustEncode renders a decoded JSON value back to text for comparison.
func mustEncode(t *testing.T, v any) string {
	t.Helper()
	encoded, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("re-encoding a response: %v", err)
	}
	return string(encoded)
}
