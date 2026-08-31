package api_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	authcore "github.com/tesserix/tesserix-home/platform-auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/bao"
	"github.com/tesserix/tesserix-home/secrets-api/internal/config"
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

// publicRoutes is an allowlist, and that direction is the whole point. Per-route
// tests prove the gates someone remembered; this proves there are no others.
// A route added in six months and left ungated fails here, which is the only
// test that can catch it.
var publicRoutes = map[string]bool{
	"GET /healthz": true,
	"GET /readyz":  true,
}

const testProject = "386377229942128837"

// stubParser stands in for Zitadel's JWKS verification. It always returns
// claims for whatever role set it was built with, never an error — the tests
// in this file drive behaviour entirely through Verifier's policy layer
// (audience, roles-to-capabilities), not through parse failures.
type stubParser struct {
	roles []string
}

func (s stubParser) Parse(context.Context, string) (*authcore.Claims, error) {
	return &authcore.Claims{
		Subject:   "user-1",
		Audience:  []string{testProject},
		Roles:     s.roles,
		ExpiresAt: time.Now().Add(time.Hour),
	}, nil
}

// stubBaoServer accepts every request and answers reads with an empty object.
// It is never actually called: TestEveryRouteIsGatedOrExplicitlyPublic sends
// no credentials, so RequireBearer refuses before any handler runs, and
// TestPlatformOnlyPrincipalCannotReachLiveRoutes is refused one gate later, by
// RequireCapability, for the same reason. It exists only so
// handlers.NewAccess is constructible and its six routes are registered by
// NewRouter, the way they are in production.
func stubBaoServer(t *testing.T) *bao.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"keys": []string{}}})
	}))
	t.Cleanup(srv.Close)

	client, err := bao.New(bao.Config{Address: srv.URL, Mount: "kv", Token: "test-token"})
	if err != nil {
		t.Fatalf("bao.New: %v", err)
	}
	return client
}

// testDeps returns the narrowest Deps that does not panic at NewRouter
// construction time and that registers every route NewRouter can register —
// Bao included. A nil Bao is how NewRouter models "OpenBao is not deployed
// here", and it makes NewAccess's six routes vanish from r.Routes() entirely;
// a test built on that nil would ask nothing about the highest-risk routes
// in the service (the ones that write OpenBao) and pass regardless of how
// they were gated, or whether they were registered at all.
func testDeps(t *testing.T, roles []string) api.Deps {
	t.Helper()
	registry, err := secrets.NewRegistry(secrets.BackendOpenBao, map[secrets.Backend]secrets.Store{
		secrets.BackendOpenBao: stubStore{},
	})
	if err != nil {
		t.Fatalf("secrets.NewRegistry: %v", err)
	}
	return api.Deps{
		Config:   config.Config{},
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		Bao:      stubBaoServer(t),
		Secrets:  registry,
		Audit:    audit.New(io.Discard),
		Verifier: authcore.NewVerifier(stubParser{roles: roles}, testProject),
	}
}

// stubStore is the narrowest secrets.Store that lets TestPlatformOnlyPrincipalCannotReachLiveRoutes
// reach List and Write without a real backend behind them. Only List is
// actually invoked — the write cases are refused by RequireCapability before
// the handler runs — but every method must exist to satisfy the interface.
type stubStore struct{}

func (stubStore) List(context.Context, string) ([]secrets.Entry, error) { return nil, nil }
func (stubStore) Describe(context.Context, string) (secrets.Secret, error) {
	return secrets.Secret{}, nil
}
func (stubStore) Write(context.Context, string, map[string]string, int) (int, error) {
	return 0, nil
}
func (stubStore) Delete(context.Context, string) error                        { return nil }
func (stubStore) Destroy(context.Context, string) error                       { return nil }
func (stubStore) Restore(context.Context, string, int) error                  { return nil }
func (stubStore) Versions(context.Context, string) ([]secrets.Version, error) { return nil, nil }
func (stubStore) Health(context.Context) error                                { return nil }

func TestEveryRouteIsGatedOrExplicitlyPublic(t *testing.T) {
	r := api.NewRouter(testDeps(t, nil))

	routes := r.Routes()
	// A silently shrinking router — say, NewAccess stops being registered
	// because Bao went back to nil in this test — would make every remaining
	// assertion in this test vacuously true: an empty router trivially has no
	// ungated route. This is the tripwire for that. The service registers 26
	// routes today (24 gated + the 2 public ones above); update this constant
	// when a route is deliberately added or removed, not when it silently
	// stops appearing.
	const wantRoutes = 26
	if len(routes) != wantRoutes {
		t.Fatalf("router registered %d routes, want %d — did a handler fail to register, or did the route count genuinely change?", len(routes), wantRoutes)
	}

	for _, route := range routes {
		key := route.Method + " " + route.Path
		if publicRoutes[key] {
			continue
		}

		req := httptest.NewRequest(route.Method, concretePath(route.Path), nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		// No credentials at all must never reach a handler. 401 is the only
		// correct answer; a 200, a 400 from body binding, or a 404 all mean the
		// request got past authentication.
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s answered %d without credentials, want 401 — is it gated?", key, w.Code)
		}
	}
}

// TestPlatformOnlyPrincipalCannotReachLiveRoutes pins the boundary that
// TestEveryRouteIsGatedOrExplicitlyPublic cannot see: 401-without-credentials
// is identical for the read and live tiers, so that test alone would not
// notice PUT /api/secrets/*path moving from live to read, or Register's two
// gin.IRoutes arguments being swapped. This test authenticates as a principal
// holding ONLY the platform capability — no rotate-credentials — and checks
// that a read route lets it through while a live route in the same handler
// refuses it with 403.
func TestPlatformOnlyPrincipalCannotReachLiveRoutes(t *testing.T) {
	r := api.NewRouter(testDeps(t, []string{string(authcore.CapPlatform)}))

	cases := []struct {
		method, path string
		wantForbid   bool
	}{
		{http.MethodGet, "/api/secrets", false},
		{http.MethodPut, "/api/secrets/x", true},
		{http.MethodGet, "/api/access/grants", false},
		{http.MethodPost, "/api/access/grants", true},
	}

	for _, tc := range cases {
		body := io.Reader(nil)
		if tc.method != http.MethodGet {
			body = strings.NewReader("{}")
		}
		req := httptest.NewRequest(tc.method, tc.path, body)
		req.Header.Set("Authorization", "Bearer aaa.bbb.ccc")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if tc.wantForbid {
			if w.Code != http.StatusForbidden {
				t.Errorf("%s %s answered %d for a platform-only principal, want 403 (live tier)", tc.method, tc.path, w.Code)
			}
			continue
		}
		if w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
			t.Errorf("%s %s answered %d for a platform-only principal, want neither 401 nor 403 (read tier)", tc.method, tc.path, w.Code)
		}
	}
}

// concretePath replaces gin's :param and *path wildcards so the request routes.
func concretePath(pattern string) string {
	out := ""
	for _, segment := range splitPath(pattern) {
		switch {
		case segment == "":
			continue
		case segment[0] == ':' || segment[0] == '*':
			out += "/x"
		default:
			out += "/" + segment
		}
	}
	if out == "" {
		return "/"
	}
	return out
}

func splitPath(pattern string) []string {
	return strings.Split(pattern, "/")
}
