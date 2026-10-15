package handler_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/repos"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// Exercised through the REAL router, the real verifier and an httptest server
// standing in for GitHub. Only the token's signature is faked.

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
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

// fakeRepo is one repository's state on the fake GitHub.
type fakeRepo struct {
	visibility string
	archived   bool
	protected  bool
	dependabot bool
	// refuse makes the next PATCH answer 422 with this message.
	refuse string
}

// fakeGitHub is GitHub, as far as this module asks it anything.
type fakeGitHub struct {
	mu    sync.Mutex
	repos map[string]*fakeRepo
	// dependabotStatus, when non-zero, is the org alert read's answer.
	dependabotStatus int
	patches          []string
}

func newFakeGitHub() *fakeGitHub {
	return &fakeGitHub{repos: map[string]*fakeRepo{
		"web":     {visibility: "public", protected: true, dependabot: true},
		"secrets": {visibility: "private", dependabot: true},
		"old":     {visibility: "private", archived: true},
	}}
}

func (f *fakeGitHub) repoJSON(name string, r *fakeRepo) map[string]any {
	return map[string]any{
		"name": name, "html_url": "https://github.com/tesserix/" + name,
		"visibility": r.visibility, "archived": r.archived, "default_branch": "main",
		"pushed_at": "2026-10-01T09:00:00Z", "stargazers_count": 3,
	}
}

func (f *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	write := func(status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	path := r.URL.Path
	switch {
	case r.Method == http.MethodPost && path == "/app/installations/42/access_tokens":
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			write(401, map[string]any{"message": "no assertion"})
			return
		}
		write(201, map[string]any{"token": "ghs_test", "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
		return
	case r.Header.Get("Authorization") != "Bearer ghs_test":
		write(401, map[string]any{"message": "Bad credentials"})
		return
	case path == "/orgs/tesserix/repos":
		// Two pages, so following the Link header is exercised.
		if r.URL.Query().Get("page") == "2" {
			write(200, []any{f.repoJSON("old", f.repos["old"])})
			return
		}
		w.Header().Set("Link", fmt.Sprintf(`<http://%s/orgs/tesserix/repos?page=2>; rel="next"`, r.Host))
		write(200, []any{f.repoJSON("web", f.repos["web"]), f.repoJSON("secrets", f.repos["secrets"])})
		return
	case path == "/orgs/tesserix/dependabot/alerts":
		if f.dependabotStatus != 0 {
			write(f.dependabotStatus, map[string]any{"message": "Resource not accessible by integration"})
			return
		}
		alert := func(repo, severity string) map[string]any {
			return map[string]any{"repository": map[string]any{"name": repo},
				"security_advisory": map[string]any{"severity": severity}}
		}
		write(200, []any{alert("web", "critical"), alert("web", "high"), alert("web", "high"), alert("secrets", "low")})
		return
	case path == "/orgs/tesserix/secret-scanning/alerts":
		write(200, []any{map[string]any{"repository": map[string]any{"name": "web"}}})
		return
	}

	parts := strings.Split(strings.TrimPrefix(path, "/repos/tesserix/"), "/")
	repo, ok := f.repos[parts[0]]
	if !strings.HasPrefix(path, "/repos/tesserix/") || !ok {
		write(404, map[string]any{"message": "Not Found"})
		return
	}
	switch {
	case len(parts) == 3 && parts[1] == "branches":
		write(200, map[string]any{"protected": repo.protected})
	case len(parts) == 2 && parts[1] == "vulnerability-alerts":
		if repo.dependabot {
			w.WriteHeader(204)
		} else {
			write(404, map[string]any{"message": "Vulnerability alerts are disabled."})
		}
	case len(parts) == 1 && r.Method == http.MethodGet:
		write(200, f.repoJSON(parts[0], repo))
	case len(parts) == 1 && r.Method == http.MethodPatch:
		if repo.refuse != "" {
			write(422, map[string]any{"message": repo.refuse})
			return
		}
		var patch map[string]any
		_ = json.NewDecoder(r.Body).Decode(&patch)
		if v, ok := patch["visibility"].(string); ok {
			repo.visibility = v
		}
		if v, ok := patch["archived"].(bool); ok {
			repo.archived = v
		}
		f.patches = append(f.patches, parts[0])
		write(200, f.repoJSON(parts[0], repo))
	default:
		write(404, map[string]any{"message": "Not Found"})
	}
}

func testKey(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
}

type api struct {
	handler http.Handler
	t       *testing.T
	gh      *fakeGitHub
	pool    *pgxpool.Pool
	module  *repos.Module
}

type options struct {
	roles      []string
	configured bool
	pool       *pgxpool.Pool
}

func serveWith(t *testing.T, o options) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	gh := newFakeGitHub()
	server := httptest.NewServer(gh)
	t.Cleanup(server.Close)

	cfg := repos.Config{HTTPClient: server.Client(), Pool: o.pool, Log: log}
	if o.configured {
		cfg.GitHub = repos.GitHub{AppID: "7", InstallationID: "42", PrivateKeyPEM: testKey(t), Org: "tesserix", BaseURL: server.URL}
	}
	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(o.roles...)}, projectID)
	cfg.Verifier = verifier
	module := repos.New(cfg)
	httpx.RegisterModule(mux, verifier, "repos", module.Register)
	return &api{handler: httpx.WithMiddleware(mux), t: t, gh: gh, pool: o.pool, module: module}
}

// serve is an operator holding both capabilities, against a configured App and
// no database — enough for every read and every refusal that precedes a write.
func serve(t *testing.T) *api {
	t.Helper()
	return serveWith(t, options{roles: []string{"platform", "repo-admin"}, configured: true})
}

// serveDB adds a real, migrated database, for the writes and their audit rows.
func serveDB(t *testing.T) *api {
	t.Helper()
	return serveWith(t, options{roles: []string{"platform", "repo-admin"}, configured: true, pool: testdb.New(t)})
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a *api) do(method, path, body string) response {
	a.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (r response) data(t *testing.T) map[string]any {
	t.Helper()
	if r.status != http.StatusOK || r.body["success"] != true {
		t.Fatalf("not a success (%d): %s", r.status, r.raw)
	}
	return r.body["data"].(map[string]any)
}

func reposByName(t *testing.T, data map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, row := range data["repos"].([]any) {
		repo := row.(map[string]any)
		out[repo["name"].(string)] = repo
	}
	return out
}

func TestAnUnconfiguredAppAnswers501NotAnEmptyOrg(t *testing.T) {
	a := serveWith(t, options{roles: []string{"platform", "repo-admin"}})
	if got := a.do(http.MethodGet, "/v1/repos", ""); got.status != http.StatusNotImplemented {
		t.Fatalf("GET /v1/repos unconfigured = %d, want 501: %s", got.status, got.raw)
	}
	got := a.do(http.MethodPost, "/v1/repos/archive", `{"repos":["web"],"archived":true}`)
	if got.status != http.StatusNotImplemented {
		t.Fatalf("POST /v1/repos/archive unconfigured = %d, want 501: %s", got.status, got.raw)
	}
}

func TestTheListingFollowsPaginationAndIsSortedByName(t *testing.T) {
	data := serve(t).do(http.MethodGet, "/v1/repos", "").data(t)
	var names []string
	for _, row := range data["repos"].([]any) {
		names = append(names, row.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "old,secrets,web" {
		t.Fatalf("names = %v, want old,secrets,web — the second page was not followed or not sorted", names)
	}
	if data["org"] != "tesserix" {
		t.Errorf("org = %v", data["org"])
	}
	if gaps, ok := data["gaps"].([]any); !ok || len(gaps) != 0 {
		t.Errorf("gaps = %v, want an empty array", data["gaps"])
	}
}

func TestSignalsAreCountedWhereMeasuredAndNullWhereNot(t *testing.T) {
	rows := reposByName(t, serve(t).do(http.MethodGet, "/v1/repos", "").data(t))

	web := rows["web"]
	alerts := web["dependabot_alerts"].(map[string]any)
	if alerts["critical"] != 1.0 || alerts["high"] != 2.0 || alerts["medium"] != 0.0 {
		t.Errorf("web dependabot_alerts = %v, want critical 1, high 2, medium 0", alerts)
	}
	if web["secret_scanning_alerts"] != 1.0 {
		t.Errorf("web secret_scanning_alerts = %v, want 1", web["secret_scanning_alerts"])
	}
	if web["branch_protected"] != true {
		t.Errorf("web branch_protected = %v, want true", web["branch_protected"])
	}

	// Private on GitHub Free: secret scanning does not exist, so null — a
	// zero would be a false all-clear.
	if got, present := rows["secrets"]["secret_scanning_alerts"]; !present || got != nil {
		t.Errorf("private repo secret_scanning_alerts = %v (present %v), want null", got, present)
	}
	// Dependabot off: nothing is looking, so no counts at all.
	old := rows["old"]
	if old["dependabot_enabled"] != false {
		t.Errorf("old dependabot_enabled = %v, want false", old["dependabot_enabled"])
	}
	if got, present := old["dependabot_alerts"]; !present || got != nil {
		t.Errorf("dependabot-off repo dependabot_alerts = %v, want null", got)
	}
}

func TestAnOrgSignalGitHubRefusesIsAGapNotZeros(t *testing.T) {
	a := serve(t)
	a.gh.dependabotStatus = http.StatusForbidden
	data := a.do(http.MethodGet, "/v1/repos", "").data(t)

	gaps := data["gaps"].([]any)
	if len(gaps) != 1 || gaps[0].(map[string]any)["signal"] != "dependabot_alerts" {
		t.Fatalf("gaps = %v, want one dependabot_alerts gap", gaps)
	}
	if got := reposByName(t, data)["web"]["dependabot_alerts"]; got != nil {
		t.Errorf("web dependabot_alerts with the org read refused = %v, want null", got)
	}
}

func TestWritesRefuseMalformedRequestsBeforeTouchingGitHub(t *testing.T) {
	cases := map[string]struct {
		path, body string
		status     int
	}{
		"unknown field":           {"/v1/repos/archive", `{"repos":["web"],"archived":true,"force":true}`, 400},
		"no repos":                {"/v1/repos/archive", `{"repos":[],"archived":true}`, 422},
		"missing archived":        {"/v1/repos/archive", `{"repos":["web"]}`, 422},
		"path in a name":          {"/v1/repos/visibility", `{"repos":["../orgs"],"visibility":"public"}`, 422},
		"duplicate name":          {"/v1/repos/visibility", `{"repos":["web","web"],"visibility":"public"}`, 422},
		"unknown visibility":      {"/v1/repos/visibility", `{"repos":["web"],"visibility":"internal"}`, 422},
		"public with no reason":   {"/v1/repos/visibility", `{"repos":["web"],"visibility":"public"}`, 422},
		"public with both":        {"/v1/repos/visibility", `{"repos":["web"],"visibility":"public","window_hours":2,"permanent":true}`, 422},
		"a zero window":           {"/v1/repos/visibility", `{"repos":["web"],"visibility":"public","window_hours":0}`, 422},
		"a window past 30 days":   {"/v1/repos/visibility", `{"repos":["web"],"visibility":"public","window_hours":721}`, 422},
		"private with a window":   {"/v1/repos/visibility", `{"repos":["web"],"visibility":"private","window_hours":2}`, 422},
		"unknown query parameter": {"/v1/repos?org=other", ``, 400},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			a := serve(t)
			method := http.MethodPost
			if c.body == "" {
				method = http.MethodGet
			}
			if got := a.do(method, c.path, c.body); got.status != c.status {
				t.Errorf("= %d, want %d: %s", got.status, c.status, got.raw)
			}
			if len(a.gh.patches) != 0 {
				t.Errorf("GitHub was patched: %v", a.gh.patches)
			}
		})
	}
}

func auditRows(t *testing.T, a *api) []string {
	t.Helper()
	rows, err := a.pool.Query(context.Background(),
		`SELECT actor || ' ' || action || ' ' || target FROM console_audit_log ORDER BY occurred_at`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		out = append(out, line)
	}
	return out
}

func results(t *testing.T, r response) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, row := range r.data(t)["results"].([]any) {
		result := row.(map[string]any)
		out[result["name"].(string)] = result
	}
	return out
}

func TestAVisibilityChangeIsAppliedAndAuditedPerRepository(t *testing.T) {
	a := serveDB(t)
	got := results(t, a.do(http.MethodPost, "/v1/repos/visibility",
		`{"repos":["secrets","web","old","ghost"],"visibility":"public","window_hours":24}`))

	if r := got["secrets"]; r["ok"] != true || r["changed"] != true || r["visibility"] != "public" {
		t.Errorf("secrets = %v, want ok, changed, public", r)
	}
	// Already public: GitHub is not asked again, but the window IS recorded —
	// that is how an existing public repository gets a deadline.
	if r := got["web"]; r["ok"] != true || r["changed"] != true {
		t.Errorf("web = %v, want ok and its policy recorded", r)
	}
	if r := got["old"]; r["ok"] != false || r["error"] != "archived" {
		t.Errorf("old = %v, want the archived refusal", r)
	}
	if r := got["ghost"]; r["ok"] != false || r["error"] != "not_found" {
		t.Errorf("ghost = %v, want not_found", r)
	}

	if strings.Join(a.gh.patches, ",") != "secrets" {
		t.Errorf("patched %v, want only secrets", a.gh.patches)
	}
	want := []string{
		subjectOperator + " repos.visibility.public tesserix/secrets",
		subjectOperator + " repos.public_policy.set tesserix/web",
	}
	if rows := auditRows(t, a); strings.Join(rows, "|") != strings.Join(want, "|") {
		t.Errorf("audit rows = %v, want %v", rows, want)
	}
}

func policyOf(t *testing.T, a *api, repo string) map[string]any {
	t.Helper()
	got := reposByName(t, a.do(http.MethodGet, "/v1/repos", "").data(t))[repo]["public_policy"]
	if got == nil {
		return nil
	}
	return got.(map[string]any)
}

func TestAWindowIsListedAndClosedByTheSweeper(t *testing.T) {
	a := serveDB(t)
	results(t, a.do(http.MethodPost, "/v1/repos/visibility",
		`{"repos":["secrets"],"visibility":"public","window_hours":1}`))

	policy := policyOf(t, a, "secrets")
	if policy == nil || policy["kind"] != "temporary" || policy["revert_at"] == nil {
		t.Fatalf("secrets public_policy = %v, want a temporary window with a revert_at", policy)
	}

	ctx := context.Background()
	if n, err := a.module.ExpireDue(ctx, time.Now()); err != nil || n != 0 {
		t.Fatalf("sweep before the window closed = %d, %v; want nothing", n, err)
	}
	if n, err := a.module.ExpireDue(ctx, time.Now().Add(2*time.Hour)); err != nil || n != 1 {
		t.Fatalf("sweep after the window closed = %d, %v; want 1", n, err)
	}
	if v := a.gh.repos["secrets"].visibility; v != "private" {
		t.Errorf("secrets visibility after the sweep = %q, want private", v)
	}
	if policy := policyOf(t, a, "secrets"); policy != nil {
		t.Errorf("a private repository still lists a policy: %v", policy)
	}
	rows := auditRows(t, a)
	if last := rows[len(rows)-1]; last != "system:repos-window-sweeper repos.visibility.private tesserix/secrets" {
		t.Errorf("last audit row = %q, want the sweeper's", last)
	}
	// A second sweep has nothing left to do.
	if n, _ := a.module.ExpireDue(ctx, time.Now().Add(3*time.Hour)); n != 0 {
		t.Errorf("a second sweep changed %d", n)
	}
}

func TestAPermanentRepositoryIsNeverSwept(t *testing.T) {
	a := serveDB(t)
	results(t, a.do(http.MethodPost, "/v1/repos/visibility", `{"repos":["web"],"visibility":"public","permanent":true}`))
	if policy := policyOf(t, a, "web"); policy == nil || policy["kind"] != "permanent" || policy["revert_at"] != nil {
		t.Fatalf("web public_policy = %v, want permanent with no revert_at", policy)
	}
	if n, err := a.module.ExpireDue(context.Background(), time.Now().AddDate(1, 0, 0)); err != nil || n != 0 {
		t.Fatalf("sweep a year on = %d, %v; want nothing", n, err)
	}
	if v := a.gh.repos["web"].visibility; v != "public" {
		t.Errorf("web visibility = %q, want public", v)
	}
}

func TestAWindowOnARepositoryMadePrivateByHandIsDroppedNotReverted(t *testing.T) {
	a := serveDB(t)
	results(t, a.do(http.MethodPost, "/v1/repos/visibility", `{"repos":["secrets"],"visibility":"public","window_hours":1}`))
	a.gh.repos["secrets"].visibility = "private"
	before := len(a.gh.patches)
	if n, err := a.module.ExpireDue(context.Background(), time.Now().Add(2*time.Hour)); err != nil || n != 0 {
		t.Fatalf("sweep = %d, %v; want nothing changed", n, err)
	}
	if len(a.gh.patches) != before {
		t.Errorf("GitHub was patched for a repository already private")
	}
	var left int
	_ = a.pool.QueryRow(context.Background(), `SELECT count(*) FROM repo_visibility_policies`).Scan(&left)
	if left != 0 {
		t.Errorf("%d policy rows left, want the stale window deleted", left)
	}
}

func TestMakingARepositoryPrivateClearsItsPolicy(t *testing.T) {
	a := serveDB(t)
	results(t, a.do(http.MethodPost, "/v1/repos/visibility", `{"repos":["web"],"visibility":"public","permanent":true}`))
	results(t, a.do(http.MethodPost, "/v1/repos/visibility", `{"repos":["web"],"visibility":"private"}`))
	var left int
	_ = a.pool.QueryRow(context.Background(), `SELECT count(*) FROM repo_visibility_policies`).Scan(&left)
	if left != 0 {
		t.Errorf("%d policy rows left after making it private", left)
	}
}

func TestAChangeGitHubRefusesLeavesNoAuditRow(t *testing.T) {
	a := serveDB(t)
	a.gh.repos["secrets"].refuse = "Visibility can't be changed for forks"
	got := results(t, a.do(http.MethodPost, "/v1/repos/visibility", `{"repos":["secrets"],"visibility":"public","window_hours":2}`))

	r := got["secrets"]
	if r["ok"] != false || r["error"] != "refused" || !strings.Contains(r["message"].(string), "forks") {
		t.Errorf("secrets = %v, want a refusal carrying GitHub's sentence", r)
	}
	if rows := auditRows(t, a); len(rows) != 0 {
		t.Errorf("audit rows = %v, want none for a change that did not happen", rows)
	}
}

func TestArchiveAndUnarchiveAreDistinctAuditedActs(t *testing.T) {
	a := serveDB(t)
	results(t, a.do(http.MethodPost, "/v1/repos/archive", `{"repos":["web"],"archived":true}`))
	results(t, a.do(http.MethodPost, "/v1/repos/archive", `{"repos":["old"],"archived":false}`))

	want := []string{
		subjectOperator + " repos.archive tesserix/web",
		subjectOperator + " repos.unarchive tesserix/old",
	}
	if rows := auditRows(t, a); strings.Join(rows, "|") != strings.Join(want, "|") {
		t.Errorf("audit rows = %v, want %v", rows, want)
	}
}
