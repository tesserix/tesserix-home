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
