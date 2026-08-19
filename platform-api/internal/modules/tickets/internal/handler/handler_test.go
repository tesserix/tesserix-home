package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// The module is exercised through its REAL router, its real verifier and a
// real database. Only the token's signature is faked, because that is the one
// part that must not be reimplemented for a test — everything else (the
// capability gate, the envelope, the transaction) is what these assertions are
// about.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
)

// stubParser stands in for Zitadel's JWKS. It verifies nothing; the Verifier's
// own policy — audience, expiry, roles — still runs on what it returns.
type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:   subjectOperator,
		Email:     "operator@tesserix.test",
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

// jwtShaped is three dot-separated segments, because the Verifier refuses an
// opaque token before it parses anything — that check is deliberate and this
// must get past it.
const jwtShaped = "header.payload.signature"

type api struct {
	handler http.Handler
	pool    *pgxpool.Pool
	t       *testing.T
}

func serve(t *testing.T, claims *auth.Claims) api {
	t.Helper()
	pool := testdb.New(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: claims}, projectID)
	// Through RegisterModule, not tickets.Register directly: registering a
	// module is exactly where the "no verifier, no module" guard lives, and a
	// test that went around it would not be testing how the module is served.
	httpx.RegisterModule(mux, verifier, "tickets", func(m *http.ServeMux) {
		tickets.Register(m, tickets.Config{Pool: pool, Verifier: verifier, Log: log})
	})

	return api{handler: httpx.WithMiddleware(mux), pool: pool, t: t}
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a api) do(method, path, body string, headers map[string]string) response {
	a.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a api) get(path string) response { return a.do(http.MethodGet, path, "", nil) }

// data returns the payload, failing if the envelope reported a failure.
func (r response) data(t *testing.T) map[string]any {
	t.Helper()
	if r.body["success"] != true {
		t.Fatalf("status %d: %s", r.status, r.raw)
	}
	payload, ok := r.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is missing or not an object: %s", r.raw)
	}
	return payload
}

func (a api) seedTicket(subject, status, priority string) string {
	a.t.Helper()
	var id string
	err := a.pool.QueryRow(context.Background(),
		`INSERT INTO platform_tickets
		   (product_id, tenant_id, ticket_number, subject, description,
		    status, priority, submitted_by_name, submitted_by_email)
		 VALUES ('mark8ly', '3f2a1c94-0000-4000-8000-0000000000aa'::uuid, $1, $2,
		         'the description', $3, $4, 'A Merchant', 'merchant@example.test')
		 RETURNING id::text`,
		"M8-"+subject, subject, status, priority,
	).Scan(&id)
	if err != nil {
		a.t.Fatalf("seeding: %v", err)
	}
	return id
}

func (a api) auditRows() []map[string]string {
	a.t.Helper()
	rows, err := a.pool.Query(context.Background(),
		`SELECT actor, action, COALESCE(target,''), COALESCE(metadata,'')
		   FROM console_audit_log ORDER BY occurred_at, action`)
	if err != nil {
		a.t.Fatalf("reading the audit trail: %v", err)
	}
	defer rows.Close()

	var out []map[string]string
	for rows.Next() {
		var actor, action, target, metadata string
		if err := rows.Scan(&actor, &action, &target, &metadata); err != nil {
			a.t.Fatalf("scanning: %v", err)
		}
		out = append(out, map[string]string{
			"actor": actor, "action": action, "target": target, "metadata": metadata,
		})
	}
	return out
}

// ---- the authorisation boundary ----------------------------------------

// #269's acceptance criterion, stated in its own words: "Capability
// enforcement in the API, verified by a test that calling a module without the
// capability is refused."
//
// The reason it matters is the sharpest point in that issue. #244 puts surface
// refusal in the console's middleware. If this API authorised only "is this a
// valid session", anything holding a session could call the module directly
// and every console restriction would be decoration.
func TestEveryRouteRefusesAPrincipalWithoutTheSurfaceCapability(t *testing.T) {
	// A token that is entirely valid — right issuer, right audience, not
	// expired — and holds `read`, which #261 reduced to console entry and
	// nothing else. This is the exact shape of the threat: a real session.
	a := serve(t, tokenFor("read"))
	id := a.seedTicket("s1", "open", "high")

	for _, route := range []struct{ method, path, body string }{
		{http.MethodGet, "/v1/tickets", ""},
		{http.MethodGet, "/v1/tickets/summary", ""},
		{http.MethodGet, "/v1/tickets/" + id, ""},
		{http.MethodPost, "/v1/tickets/" + id + "/replies", `{"content":"hello"}`},
		{http.MethodPatch, "/v1/tickets/" + id, `{"status":"resolved"}`},
	} {
		got := a.do(route.method, route.path, route.body, nil)
		if got.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403 — a valid session is not authorisation",
				route.method, route.path, got.status)
		}
	}
}

// The verb is not inherited from the surface. #261 spent an issue undoing the
// opposite arrangement on the console side, where 11 of 14 mutating actions
// inherited the weakest gate by saying nothing.
func TestReadingIsAllowedWithoutTheVerbAndWritingIsNot(t *testing.T) {
	a := serve(t, tokenFor("read", "support"))
	id := a.seedTicket("s1", "open", "high")

	if got := a.get("/v1/tickets/" + id); got.status != http.StatusOK {
		t.Errorf("reading with `support` = %d, want 200; the queue is genuinely readable", got.status)
	}
	for _, route := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/tickets/" + id + "/replies", `{"content":"hello"}`},
		{http.MethodPatch, "/v1/tickets/" + id, `{"status":"resolved"}`},
	} {
		if got := a.do(route.method, route.path, route.body, nil); got.status != http.StatusForbidden {
			t.Errorf("%s without `respond` = %d, want 403", route.method, got.status)
		}
	}
}

// The other direction: the verb does not stand in for the surface. #261's
// model layers a verb on top of surface access rather than replacing it —
// `respond` without `support` means "may reply where they may work", not "may
// reply anywhere".
func TestTheVerbAloneIsNotEnough(t *testing.T) {
	a := serve(t, tokenFor("read", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"hello"}`, nil)

	if got.status != http.StatusForbidden {
		t.Errorf("respond without support = %d, want 403", got.status)
	}
}

func TestARefusalIsNotAnAccident(t *testing.T) {
	// A 403 that happened because the route does not exist, or because the
	// ticket does not, would satisfy the tests above while proving nothing.
	// This is the same request with the capabilities present.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"hello"}`, nil)

	if got.status != http.StatusCreated {
		t.Fatalf("the same request with the capabilities = %d, want 201: %s", got.status, got.raw)
	}
}

func TestAnUnauthenticatedRequestIs401AndNot403(t *testing.T) {
	// Different questions with different answers: "who are you" and "may you".
	// A caller told 403 would go looking for a missing role when the problem
	// is a missing token.
	a := serve(t, tokenFor("read", "support"))

	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", rec.Code)
	}
}

// ---- the contract ------------------------------------------------------

func TestTheListingAndTheSummaryAreSeparateResources(t *testing.T) {
	// The central decision of #269. The endpoint being replaced returns
	// {summary, rows} — one screen's payload, spanning a standing count of the
	// whole queue and a filtered page of it. Here they are two resources and
	// the console composes them.
	a := serve(t, tokenFor("read", "support"))
	a.seedTicket("s1", "open", "urgent")
	a.seedTicket("s2", "closed", "low")

	listing := a.get("/v1/tickets").data(t)
	if _, present := listing["summary"]; present {
		t.Error("the listing carries a summary; that is the screen shape #269 rejects")
	}
	tickets, ok := listing["tickets"].([]any)
	if !ok || len(tickets) != 2 {
		t.Fatalf("tickets = %v", listing["tickets"])
	}

	summary := a.get("/v1/tickets/summary").data(t)["summary"].(map[string]any)
	if summary["open"] != float64(1) || summary["urgent_open"] != float64(1) {
		t.Errorf("summary = %v", summary)
	}
}

func TestTheSummaryDoesNotMoveWhenTheListingIsFiltered(t *testing.T) {
	// The property the console's own contract test asserts, preserved by the
	// split rather than in spite of it: the summary is a property of the
	// QUEUE, and there is no way to ask it for a filtered one.
	a := serve(t, tokenFor("read", "support"))
	a.seedTicket("s1", "open", "urgent")
	a.seedTicket("s2", "closed", "low")

	whole := a.get("/v1/tickets/summary").data(t)["summary"]

	filtered := a.get("/v1/tickets?status=open").data(t)["tickets"].([]any)
	if len(filtered) != 1 {
		t.Fatalf("the filter did not narrow the listing: %v", filtered)
	}

	again := a.get("/v1/tickets/summary").data(t)["summary"]
	if fmt.Sprint(whole) != fmt.Sprint(again) {
		t.Errorf("the summary changed with the listing's filter: %v then %v", whole, again)
	}
}

func TestTheListingReportsItsPageHonestly(t *testing.T) {
	a := serve(t, tokenFor("read", "support"))
	for i := range 5 {
		a.seedTicket(fmt.Sprintf("s%d", i), "open", "high")
	}

	got := a.get("/v1/tickets?limit=2")
	meta, ok := got.body["meta"].(map[string]any)
	if !ok {
		t.Fatalf("meta is missing: %s", got.raw)
	}
	if meta["total"] != float64(5) {
		t.Errorf("total = %v, want 5 — every matching row, ignoring the limit", meta["total"])
	}
	if meta["preceding_count"] != float64(0) {
		t.Errorf("preceding_count = %v, want 0 on the first page", meta["preceding_count"])
	}
	if meta["limit"] != float64(2) {
		t.Errorf("limit = %v, want the applied limit echoed", meta["limit"])
	}
	if _, present := meta["next_cursor"]; !present {
		t.Error("no next_cursor on a page with more behind it")
	}
	if _, present := meta["previous_cursor"]; present {
		t.Error("the first page offered a previous_cursor")
	}
	for _, offset := range []string{"page", "per_page", "total_pages"} {
		if _, present := meta[offset]; present {
			t.Errorf("meta carries %q; this API pages by cursor", offset)
		}
	}
}

func TestAnOversizedLimitIsClampedAndSaidSo(t *testing.T) {
	// Clamped rather than rejected — a caller asking for more than the service
	// will serve made a reasonable request — but the response says what was
	// actually applied, so a short page is not mistaken for the end of the
	// queue.
	a := serve(t, tokenFor("read", "support"))
	a.seedTicket("s1", "open", "high")

	got := a.get("/v1/tickets?limit=100000")

	if got.status != http.StatusOK {
		t.Fatalf("status = %d: %s", got.status, got.raw)
	}
	if meta := got.body["meta"].(map[string]any); meta["limit"] != float64(200) {
		t.Errorf("limit = %v, want it clamped to the maximum and reported", meta["limit"])
	}
}

func TestAZeroLimitIsRefusedRatherThanClamped(t *testing.T) {
	// Asking for no rows is a bug in the caller — most likely an
	// uninitialised variable — and silently serving 50 would hide it.
	a := serve(t, tokenFor("read", "support"))

	if got := a.get("/v1/tickets?limit=0"); got.status != http.StatusUnprocessableEntity {
		t.Errorf("limit=0 = %d, want 422", got.status)
	}
}

func TestAMalformedCursorIs400AndNotAQuietFirstPage(t *testing.T) {
	// The cursor came off a URL, so this is a bad LINK rather than a flaky
	// read, and the two want opposite advice. Serving page one would show the
	// caller something other than what they asked for and report success.
	a := serve(t, tokenFor("read", "support"))
	a.seedTicket("s1", "open", "high")

	got := a.get("/v1/tickets?cursor=obviously-not-a-cursor")

	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", got.status, got.raw)
	}
}

func TestAnUnknownFilterValueIsRefusedRatherThanReturningNothing(t *testing.T) {
	// An empty page is indistinguishable from "no tickets match", so a typo'd
	// filter would read as a quiet queue.
	a := serve(t, tokenFor("read", "support"))

	got := a.get("/v1/tickets?status=opne")

	if got.status != http.StatusUnprocessableEntity {
		t.Errorf("status = %d, want 422: %s", got.status, got.raw)
	}
}

func TestAnAbsentTicketIs404(t *testing.T) {
	a := serve(t, tokenFor("read", "support"))

	got := a.get("/v1/tickets/3f2a1c94-0000-4000-8000-000000000999")

	if got.status != http.StatusNotFound {
		t.Errorf("status = %d, want 404: %s", got.status, got.raw)
	}
	if got.body["success"] != false {
		t.Errorf("a 404 must be the estate envelope: %s", got.raw)
	}
}

func TestTheDetailCarriesTheTicketAndItsThread(t *testing.T) {
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")
	a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"looking into it"}`, nil)

	payload := a.get("/v1/tickets/" + id).data(t)

	ticket := payload["ticket"].(map[string]any)
	if ticket["description"] != "the description" {
		t.Errorf("description = %v", ticket["description"])
	}
	if ticket["resolved_at"] != nil {
		t.Errorf("resolved_at = %v, want an explicit null on an unresolved ticket", ticket["resolved_at"])
	}
	replies := payload["replies"].([]any)
	if len(replies) != 1 {
		t.Fatalf("replies = %v", replies)
	}
	if replies[0].(map[string]any)["author_type"] != "platform_admin" {
		t.Errorf("author_type = %v, want the value the console's parser accepts",
			replies[0].(map[string]any)["author_type"])
	}
}

func TestAnEmptyThreadIsAnArrayAndNotNull(t *testing.T) {
	// A client that types the field as an array meets a type error on the one
	// response it is least likely to have exercised.
	a := serve(t, tokenFor("read", "support"))
	id := a.seedTicket("s1", "open", "high")

	if !strings.Contains(a.get("/v1/tickets/"+id).raw, `"replies":[]`) {
		t.Errorf("an empty thread did not serialise as []: %s", a.get("/v1/tickets/"+id).raw)
	}
}

func TestAnEmptyQueueIsAnArrayAndNotNull(t *testing.T) {
	a := serve(t, tokenFor("read", "support"))

	if !strings.Contains(a.get("/v1/tickets").raw, `"tickets":[]`) {
		t.Errorf("an empty queue did not serialise as []: %s", a.get("/v1/tickets").raw)
	}
}

func TestNoResponseCarriesAnIdentifierFromAnotherIssuer(t *testing.T) {
	// submitted_by_user_id and the reply author's are attribution the database
	// keeps. Putting a Firebase UID or a Zitadel subject on the wire would
	// publish a join key to every caller for no reader's benefit.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")
	a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"noted"}`, nil)

	for _, path := range []string{"/v1/tickets", "/v1/tickets/" + id} {
		body := a.get(path).raw
		for _, leak := range []string{"user_id", subjectOperator} {
			if strings.Contains(body, leak) {
				t.Errorf("%s leaks %q: %s", path, leak, body)
			}
		}
	}
}

// ---- writes ------------------------------------------------------------

func TestAReplyLandsAndIsAudited(t *testing.T) {
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"on it"}`, nil)

	if got.status != http.StatusCreated {
		t.Fatalf("status = %d: %s", got.status, got.raw)
	}
	payload := got.data(t)
	if payload["reply"].(map[string]any)["content"] != "on it" {
		t.Errorf("reply = %v", payload["reply"])
	}
	// The ticket travels with the reply so a caller that transitioned it does
	// not need a second read to learn the outcome.
	if payload["ticket"].(map[string]any)["id"] != id {
		t.Errorf("the response did not carry the ticket: %v", payload["ticket"])
	}

	rows := a.auditRows()
	if len(rows) != 1 {
		t.Fatalf("audit rows = %v, want exactly one", rows)
	}
	if rows[0]["action"] != "tickets.reply" || rows[0]["actor"] != subjectOperator || rows[0]["target"] != id {
		t.Errorf("audit row = %v", rows[0])
	}
	if rows[0]["metadata"] != `{"replies":1,"status_changes":0}` {
		t.Errorf("metadata = %s", rows[0]["metadata"])
	}
}

func TestTheAuditTrailNeverCarriesTheReplysText(t *testing.T) {
	// An audit trail that copies the data it exists to account for is a second
	// copy of the problem, with a longer retention and a wider read grant.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	a.do(http.MethodPost, "/v1/tickets/"+id+"/replies",
		`{"content":"card ending 4242 was double charged"}`, nil)

	for _, row := range a.auditRows() {
		if strings.Contains(fmt.Sprint(row), "4242") {
			t.Errorf("the reply's text reached the audit trail: %v", row)
		}
	}
}

func TestAnEmptyReplyIsRefused(t *testing.T) {
	// Trimmed first: a reply of spaces is an empty reply, and storing one puts
	// a blank message on a merchant's thread.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	for _, body := range []string{`{"content":""}`, `{"content":"   "}`, `{"content":"\n\t "}`} {
		got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", body, nil)
		if got.status != http.StatusUnprocessableEntity {
			t.Errorf("%s = %d, want 422: %s", body, got.status, got.raw)
		}
	}
}

func TestAnOverlongReplyIsRefusedAtTheSameLimitTheConsoleEnforces(t *testing.T) {
	// The console checks 10,000 characters before sending, and apps/web's
	// replySchema caps at the same number. A reply the console accepts and
	// this rejects would fail after the operator has typed it.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	body, _ := json.Marshal(map[string]string{"content": strings.Repeat("a", 10_001)})

	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", string(body), nil)

	if got.status != http.StatusUnprocessableEntity {
		t.Errorf("status = %d, want 422: %s", got.status, got.raw)
	}
}

func TestAReplyAndItsTransitionAreOneAct(t *testing.T) {
	// Two calls can half-fail: the merchant gets an answer on a ticket that
	// stays open, or the ticket closes under a reply that never landed. There
	// is no transaction across two HTTP requests to put that right.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies",
		`{"content":"fixed","newStatus":"resolved"}`, nil)

	if got.status != http.StatusCreated {
		t.Fatalf("status = %d: %s", got.status, got.raw)
	}
	ticket := got.data(t)["ticket"].(map[string]any)
	if ticket["status"] != "resolved" {
		t.Errorf("status = %v, want the transition applied in the same request", ticket["status"])
	}
	if ticket["resolved_at"] == nil {
		t.Error("resolving did not stamp resolved_at")
	}
	if rows := a.auditRows(); rows[0]["metadata"] != `{"replies":1,"status_changes":1}` {
		t.Errorf("metadata = %s, want the transition counted", rows[0]["metadata"])
	}
}

func TestARejectedTransitionTakesTheReplyDownWithIt(t *testing.T) {
	// The atomicity that makes the previous test's guarantee real. A reply
	// that survived its own failed transition would be the half-failure the
	// single call exists to prevent.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies",
		`{"content":"this must not land","newStatus":"open"}`, nil)

	if got.status != http.StatusUnprocessableEntity {
		t.Fatalf("transitioning to the current status = %d, want 422: %s", got.status, got.raw)
	}
	replies := a.get("/v1/tickets/" + id).data(t)["replies"].([]any)
	if len(replies) != 0 {
		t.Errorf("the reply survived its failed transition: %v", replies)
	}
	if rows := a.auditRows(); len(rows) != 0 {
		t.Errorf("a refused operation was audited: %v", rows)
	}
}

func TestAStatusChangeIsAudited(t *testing.T) {
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPatch, "/v1/tickets/"+id, `{"status":"in_progress"}`, nil)

	if got.status != http.StatusOK {
		t.Fatalf("status = %d: %s", got.status, got.raw)
	}
	if got.data(t)["ticket"].(map[string]any)["status"] != "in_progress" {
		t.Errorf("ticket = %v", got.data(t)["ticket"])
	}
	rows := a.auditRows()
	if len(rows) != 1 || rows[0]["action"] != "tickets.status" {
		t.Errorf("audit = %v", rows)
	}
}

func TestReopeningIsAuditedAsItsOwnAct(t *testing.T) {
	// "What was undone" is not answerable by scanning status changes in
	// general, and the distinction is only cheap to draw at the moment the
	// transition is decided.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "closed", "high")

	got := a.do(http.MethodPatch, "/v1/tickets/"+id, `{"status":"open"}`, nil)

	if got.status != http.StatusOK {
		t.Fatalf("reopening a closed ticket = %d, want 200 — the console ships the button: %s", got.status, got.raw)
	}
	if rows := a.auditRows(); len(rows) != 1 || rows[0]["action"] != "tickets.reopen" {
		t.Errorf("audit = %v, want tickets.reopen", rows)
	}
}

func TestATransitionToTheCurrentStatusIsRefused(t *testing.T) {
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPatch, "/v1/tickets/"+id, `{"status":"open"}`, nil)

	if got.status != http.StatusUnprocessableEntity {
		t.Errorf("status = %d, want 422: %s", got.status, got.raw)
	}
	if rows := a.auditRows(); len(rows) != 0 {
		t.Errorf("a refused transition was audited: %v", rows)
	}
}

func TestAnUnknownFieldIsRefusedRatherThanIgnored(t *testing.T) {
	// A caller sending {"contnet": …} should be told, not answered with a 422
	// about an empty reply that names the wrong problem. Stricter than most of
	// the estate, and worth it on a contract products pin to: an unknown field
	// today is a field this service might mean something by tomorrow.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"contnet":"typo"}`, nil)

	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// ---- idempotency -------------------------------------------------------

func TestARetriedReplyLandsOnce(t *testing.T) {
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")
	headers := map[string]string{idempotency.Header: "console-retry-1"}

	first := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"any update?"}`, headers)
	second := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"any update?"}`, headers)

	if first.status != http.StatusCreated || second.status != http.StatusCreated {
		t.Fatalf("statuses = %d then %d, want 201 both times", first.status, second.status)
	}
	// The same reply, not merely the same status: a retry that created a
	// second row and reported 201 would pass a weaker assertion.
	if first.data(t)["reply"].(map[string]any)["id"] != second.data(t)["reply"].(map[string]any)["id"] {
		t.Error("the retry created a second reply")
	}
	replies := a.get("/v1/tickets/" + id).data(t)["replies"].([]any)
	if len(replies) != 1 {
		t.Errorf("the thread holds %d replies, want 1", len(replies))
	}
	if rows := a.auditRows(); len(rows) != 1 {
		t.Errorf("the retry was audited again: %v", rows)
	}
}

func TestTheSameQuestionAskedTwiceOnPurposeStillLandsTwice(t *testing.T) {
	// The reason the key is the unit of uniqueness rather than the content.
	// Support legitimately asks "any update?" twice, and a natural key on
	// (ticket, content) would forbid it.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"any update?"}`,
		map[string]string{idempotency.Header: "first-ask"})
	a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"any update?"}`,
		map[string]string{idempotency.Header: "second-ask"})

	if replies := a.get("/v1/tickets/" + id).data(t)["replies"].([]any); len(replies) != 2 {
		t.Errorf("the thread holds %d replies, want 2", len(replies))
	}
}

func TestReusingAKeyForADifferentBodyIs409(t *testing.T) {
	// Not a retry: a client bug or a replay. Returning the first response
	// would silently discard the second request.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")
	headers := map[string]string{idempotency.Header: "console-retry-1"}

	a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"first"}`, headers)
	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"quite different"}`, headers)

	if got.status != http.StatusConflict {
		t.Errorf("status = %d, want 409: %s", got.status, got.raw)
	}
}

func TestAKeyMintedForAReplyCannotReplayAtTheStatusEndpoint(t *testing.T) {
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")
	headers := map[string]string{idempotency.Header: "shared"}

	a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"hi"}`, headers)
	// A well-formed status request, so the refusal below is about the key
	// rather than about the body — sending the reply's body here would be
	// rejected by DisallowUnknownFields before idempotency was consulted, and
	// the test would pass while proving nothing.
	got := a.do(http.MethodPatch, "/v1/tickets/"+id, `{"status":"resolved"}`, headers)

	if got.status != http.StatusConflict {
		t.Errorf("status = %d, want 409 — a key is scoped to the operation it was minted for: %s", got.status, got.raw)
	}
	if a.get("/v1/tickets/" + id).data(t)["ticket"].(map[string]any)["status"] != "open" {
		t.Error("the refused request changed the ticket anyway")
	}
}

func TestAnUnusableIdempotencyKeyIs400RatherThanSilentlyIgnored(t *testing.T) {
	// A caller who MEANT to be idempotent and got the header wrong must be
	// told. Performing the write and letting them believe it was protected is
	// the worse failure.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"hi"}`,
		map[string]string{idempotency.Header: strings.Repeat("k", 300)})

	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
	if replies := a.get("/v1/tickets/" + id).data(t)["replies"].([]any); len(replies) != 0 {
		t.Error("the write happened despite the key being refused")
	}
}

func TestAWriteWithoutAKeyStillWorks(t *testing.T) {
	// Optional, deliberately. Requiring a key would have broken every caller
	// on the day this shipped, the console included.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")

	if got := a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"hi"}`, nil); got.status != http.StatusCreated {
		t.Errorf("status = %d, want 201: %s", got.status, got.raw)
	}
}

// ---- the envelope ------------------------------------------------------

func TestEveryResponseCarriesTheEnvelopeAndARequestID(t *testing.T) {
	a := serve(t, tokenFor("read", "support"))
	id := a.seedTicket("s1", "open", "high")

	for _, path := range []string{
		"/v1/tickets", "/v1/tickets/summary", "/v1/tickets/" + id,
		"/v1/tickets/3f2a1c94-0000-4000-8000-000000000999", // a 404
	} {
		got := a.get(path)
		if _, present := got.body["success"]; !present {
			t.Errorf("%s: no success field: %s", path, got.raw)
		}
		if _, present := got.body["timestamp"]; !present {
			t.Errorf("%s: no timestamp: %s", path, got.raw)
		}
		if id, _ := got.body["request_id"].(string); id == "" {
			t.Errorf("%s: no request_id — a failure nobody can correlate: %s", path, got.raw)
		}
	}
}

func TestWireTimestampsAreUTCWhereverTheProcessRuns(t *testing.T) {
	// pgx returns timestamptz in the connection's session timezone, so this
	// same row serialises differently on a laptop in +10:00 and in a UTC
	// container. Both are valid RFC 3339 and both parse, so nothing breaks
	// loudly — which is why it is pinned rather than left to the environment.
	//
	// The golden files mask the timestamp value, which masked its offset too;
	// this was found by running the service.
	a := serve(t, tokenFor("read", "support", "respond"))
	id := a.seedTicket("s1", "open", "high")
	a.do(http.MethodPost, "/v1/tickets/"+id+"/replies", `{"content":"noted"}`, nil)
	a.do(http.MethodPatch, "/v1/tickets/"+id, `{"status":"resolved"}`, nil)

	stamps := regexp.MustCompile(`"(created_at|updated_at|resolved_at|timestamp)":"([^"]+)"`)
	for _, path := range []string{"/v1/tickets", "/v1/tickets/" + id} {
		body := a.get(path).raw
		found := stamps.FindAllStringSubmatch(body, -1)
		if len(found) == 0 {
			t.Fatalf("%s carried no timestamps to check: %s", path, body)
		}
		for _, match := range found {
			if !strings.HasSuffix(match[2], "Z") {
				t.Errorf("%s: %s = %q — not UTC, so these bytes depend on where the process runs",
					path, match[1], match[2])
			}
		}
	}
}
