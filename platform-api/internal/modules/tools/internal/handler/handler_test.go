package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// The module is exercised through its REAL router, its real verifier and a
// real database. Only the token's signature is faked.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
)

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

// processTimeZone is forced onto the test process, and deliberately not UTC.
//
// pgx decodes a timestamptz into time.Local, so time.Local — not the database
// session's zone — is what decides whether a rendered timestamp carries Z or
// an offset. Without this the suite is green in a UTC container and red on a
// laptop in +10:00, which is to say green in CI with the normalisation
// removed. The CRM module paid for this once already.
const processTimeZone = "Australia/Sydney"

func TestMain(m *testing.M) {
	zone, err := time.LoadLocation(processTimeZone)
	if err != nil {
		fmt.Fprintf(os.Stderr, "loading %s: %v\n", processTimeZone, err)
		os.Exit(1)
	}
	time.Local = zone
	now := time.Now()
	if now.Format(time.RFC3339) == now.UTC().Format(time.RFC3339) {
		fmt.Fprintf(os.Stderr, "the test process is still rendering UTC; the guard proves nothing\n")
		os.Exit(1)
	}
	os.Exit(m.Run())
}

type api struct {
	handler http.Handler
	pool    *pgxpool.Pool
	t       *testing.T
}

func serve(t *testing.T) *api { t.Helper(); return serveAs(t, "read", "platform") }

func serveAs(t *testing.T, roles ...string) *api {
	t.Helper()
	pool := testdb.New(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	// Through RegisterModule and the module's own Register, because that is
	// where the "no verifier, no module" guard lives. This composes what
	// cmd/server composes, line for line.
	httpx.RegisterModule(mux, verifier, "tools", func(m *http.ServeMux) {
		tools.Register(m, tools.Config{Pool: pool, Verifier: verifier, Log: log})
	})

	return &api{handler: httpx.WithMiddleware(mux), pool: pool, t: t}
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a *api) do(method, path, body string, headers map[string]string) response {
	a.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	// Every answer is enveloped, refusals included, so a body that will not
	// parse is a finding rather than an inconvenience.
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a *api) get(path string) response { a.t.Helper(); return a.do(http.MethodGet, path, "", nil) }

// data returns the response's `data` object, failing if the call did not
// succeed.
func (r response) data(t *testing.T) map[string]any {
	t.Helper()
	if r.body["success"] != true {
		t.Fatalf("not a success: %s", r.raw)
	}
	data, ok := r.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %s", r.raw)
	}
	return data
}

func TestTheToolsListIsTheSeededDirectory(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/platform/tools").data(t)

	// A NAMED payload object, never a bare array — §1. A client that has to
	// branch on whether `data` is an array or an object has been given two
	// contracts.
	list, ok := got["tools"].([]any)
	if !ok {
		t.Fatalf(`data.tools is not an array: %v`, got)
	}
	if len(list) != 15 {
		t.Fatalf("got %d tools, want 15", len(list))
	}

	first, _ := list[0].(map[string]any)
	if first["subdomain"] != "auth" {
		t.Errorf("first tool subdomain = %v, want auth — identity is the first group", first["subdomain"])
	}
	// snake_case on the wire, and the absent note is null rather than missing:
	// a client reading `note` should not have to distinguish the two.
	if _, ok := first["group_key"]; !ok {
		t.Error("group_key is missing; the wire is snake_case")
	}
	if note, present := first["note"]; !present || note != nil {
		t.Errorf("Zitadel's note = %v, want an explicit null", note)
	}
}

func TestTheGroupsListIsInDisplayOrder(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/platform/tool-groups").data(t)

	list, ok := got["groups"].([]any)
	if !ok {
		t.Fatalf("data.groups is not an array: %v", got)
	}
	want := []string{"identity", "observability", "delivery", "cost", "reference"}
	if len(list) != len(want) {
		t.Fatalf("got %d groups, want %d", len(list), len(want))
	}
	for i, key := range want {
		g, _ := list[i].(map[string]any)
		if g["key"] != key {
			t.Errorf("group %d = %v, want %s", i, g["key"], key)
		}
	}
}

func TestAnUnknownQueryParameterIsRefused(t *testing.T) {
	a := serve(t)

	// The read-side twin of DisallowUnknownFields. A caller sending ?groups=x
	// is told, rather than answered with the whole directory reported as a
	// success.
	got := a.get("/v1/platform/tools?group=identity")

	if got.status != http.StatusBadRequest {
		t.Errorf("an unknown parameter = %d, want 400: %s", got.status, got.raw)
	}
}

func (a *api) toolID(subdomain string) string {
	a.t.Helper()
	var id string
	if err := a.pool.QueryRow(context.Background(),
		`SELECT id FROM platform_tools WHERE subdomain = $1`, subdomain).Scan(&id); err != nil {
		a.t.Fatalf("finding %s: %v", subdomain, err)
	}
	return id
}

func TestCreatingAToolAnswers201WithTheRow(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Tempo","subdomain":"tempo","purpose":"Distributed traces.","group_key":"observability"}`, nil)

	if got.status != http.StatusCreated {
		t.Fatalf("create = %d, want 201: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	if tool["subdomain"] != "tempo" {
		t.Errorf("created tool = %v, want subdomain tempo", tool)
	}
	if tool["id"] == nil || tool["id"] == "" {
		t.Error("the created tool has no id; a client cannot address it to edit it")
	}
	// Absent sort_order means "last in its group" rather than 0, which would
	// silently make a new tool the first one.
	if order, ok := tool["sort_order"].(float64); !ok || order <= 1 {
		t.Errorf("sort_order = %v, want the end of the observability group", tool["sort_order"])
	}
}

func TestCreatingAToolWithAUrlForASubdomainIs422(t *testing.T) {
	a := serve(t)

	// The property the whole schema exists to protect: a row that carries a
	// host would send a dev console's operators to production.
	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Grafana","subdomain":"https://grafana.tesserix.app","purpose":"x","group_key":"observability"}`, nil)

	if got.status != http.StatusUnprocessableEntity {
		t.Errorf("a URL as a subdomain = %d, want 422: %s", got.status, got.raw)
	}
}

func TestCreatingAToolInAnUnknownGroupIs422AndNot500(t *testing.T) {
	a := serve(t)

	// The foreign key would refuse this anyway; the point is that the caller
	// is told which field is wrong rather than handed a constraint name.
	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"x","subdomain":"x","purpose":"x","group_key":"no-such-group"}`, nil)

	if got.status != http.StatusUnprocessableEntity {
		t.Errorf("an unknown group = %d, want 422: %s", got.status, got.raw)
	}
}

func TestCreatingADuplicateSubdomainIs409(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Another","subdomain":"auth","purpose":"x","group_key":"identity"}`, nil)

	// 409 rather than 422: the request is entirely valid, and what refuses it
	// is the state of the directory rather than the shape of the input.
	if got.status != http.StatusConflict {
		t.Errorf("a duplicate subdomain = %d, want 409: %s", got.status, got.raw)
	}
}

func TestAnUnknownFieldInTheBodyIsRefused(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"x","subdomain":"x","purpose":"x","group_key":"reference","status":"up"}`, nil)

	// `status` is the exact field this directory refuses to carry, and a
	// silent 201 that dropped it would be the worst possible answer.
	if got.status != http.StatusBadRequest {
		t.Errorf("an unknown field = %d, want 400: %s", got.status, got.raw)
	}
}

func TestPatchingChangesOnlyWhatWasSent(t *testing.T) {
	a := serve(t)
	id := a.toolID("kibana")

	got := a.do(http.MethodPatch, "/v1/platform/tools/"+id, `{"purpose":"Log search."}`, nil)

	if got.status != http.StatusOK {
		t.Fatalf("patch = %d, want 200: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	if tool["purpose"] != "Log search." {
		t.Errorf("purpose = %v, want the new value", tool["purpose"])
	}
	if tool["name"] != "Kibana" {
		t.Errorf("name = %v, want it untouched — PATCH changes what was sent", tool["name"])
	}
	if tool["group_key"] != "observability" {
		t.Errorf("group_key = %v, want it untouched", tool["group_key"])
	}
	// kibana seeds with no note. An ABSENT note key in the body must leave
	// that alone — proving "absent" rather than merely assuming it, since a
	// bug that always cleared the note would still pass every other
	// assertion here.
	if tool["note"] != nil {
		t.Errorf("note = %v, want it untouched (absent from the body) — kibana has none", tool["note"])
	}
}

func TestPatchingSetsANoteThatWasAbsent(t *testing.T) {
	a := serve(t)
	id := a.toolID("kibana")

	// kibana seeds with a NULL note. This is the third state
	// TestPatchingChangesOnlyWhatWasSent and TestPatchingCanClearANote do not
	// cover: setting a note to an actual non-empty string, as opposed to
	// leaving it absent or clearing it with an explicit null.
	got := a.do(http.MethodPatch, "/v1/platform/tools/"+id, `{"note":"Slow on cold start."}`, nil)

	if got.status != http.StatusOK {
		t.Fatalf("patch = %d, want 200: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	if tool["note"] != "Slow on cold start." {
		t.Errorf("note = %v, want the new value", tool["note"])
	}
}

func TestPatchingCanClearANote(t *testing.T) {
	a := serve(t)
	id := a.toolID("argocd")

	got := a.do(http.MethodPatch, "/v1/platform/tools/"+id, `{"note":null}`, nil)

	if got.status != http.StatusOK {
		t.Fatalf("patch = %d, want 200: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	// An explicit null clears; an ABSENT key leaves it alone. Both spellings
	// have to be expressible or a note could never be removed.
	if tool["note"] != nil {
		t.Errorf("note = %v, want null after an explicit null", tool["note"])
	}
}

func TestPatchingAnUnknownToolIs404(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPatch,
		"/v1/platform/tools/00000000-0000-0000-0000-000000000000", `{"name":"x"}`, nil)

	if got.status != http.StatusNotFound {
		t.Errorf("patching a missing tool = %d, want 404: %s", got.status, got.raw)
	}
}

func TestPatchingAMalformedIdIs404AndNot500(t *testing.T) {
	a := serve(t)

	// Unlike the well-formed-but-nonexistent uuid above, this exercises
	// Postgres's 22P02 (invalid text representation) rather than
	// pgx.ErrNoRows — the path classify maps back to ErrNoRow so a caller's
	// typo in the id is a 404, not a 500.
	got := a.do(http.MethodPatch, "/v1/platform/tools/not-a-uuid", `{"name":"x"}`, nil)

	if got.status != http.StatusNotFound {
		t.Errorf("patching a malformed id = %d, want 404: %s", got.status, got.raw)
	}
}

func TestDeletingAMalformedIdIs404AndNot500(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodDelete, "/v1/platform/tools/not-a-uuid", "", nil)

	if got.status != http.StatusNotFound {
		t.Errorf("deleting a malformed id = %d, want 404: %s", got.status, got.raw)
	}
}

func TestDeletingAToolRemovesItAndAnswersWithIt(t *testing.T) {
	a := serve(t)
	id := a.toolID("docs")

	got := a.do(http.MethodDelete, "/v1/platform/tools/"+id, "", nil)

	if got.status != http.StatusOK {
		t.Fatalf("delete = %d, want 200: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	if tool["subdomain"] != "docs" {
		t.Errorf("delete answered with %v, want the row as it was", tool)
	}
	if after := a.get("/v1/platform/tools").data(t)["tools"].([]any); len(after) != 14 {
		t.Errorf("after deleting one of 15 there are %d", len(after))
	}
}

func TestARepeatedWriteUnderOneIdempotencyKeyHappensOnce(t *testing.T) {
	a := serve(t)
	body := `{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`
	headers := map[string]string{"Idempotency-Key": "6f1c0f4e-2b7a-4a1f-9d3e-0c5b8a2e7d11"}

	first := a.do(http.MethodPost, "/v1/platform/tools", body, headers)
	second := a.do(http.MethodPost, "/v1/platform/tools", body, headers)

	if first.status != http.StatusCreated {
		t.Fatalf("first create = %d, want 201: %s", first.status, first.raw)
	}
	// The replay is the SAME answer, not a 409 from the unique constraint —
	// which is what a retry would get without the idempotency record.
	if second.status != first.status {
		t.Errorf("replay = %d, want the stored %d: %s", second.status, first.status, second.raw)
	}
	if got := len(a.get("/v1/platform/tools").data(t)["tools"].([]any)); got != 16 {
		t.Errorf("after one create and one replay there are %d tools, want 16", got)
	}
}

func TestAWriteRecordsAnAuditRow(t *testing.T) {
	a := serve(t)

	a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`, nil)

	var action, actor string
	err := a.pool.QueryRow(context.Background(),
		`SELECT action, actor FROM console_audit_log ORDER BY occurred_at DESC LIMIT 1`).
		Scan(&action, &actor)
	if err != nil {
		t.Fatalf("reading the audit trail: %v", err)
	}
	if action != "platform.tool.created" {
		t.Errorf("action = %q, want platform.tool.created", action)
	}
	if actor != subjectOperator {
		t.Errorf("actor = %q, want the principal's subject", actor)
	}
}
