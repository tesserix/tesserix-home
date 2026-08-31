package api_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	authcore "github.com/tesserix/tesserix-home/platform-auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api"
	"github.com/tesserix/tesserix-home/secrets-api/internal/config"
)

// publicRoutes is an allowlist, and that direction is the whole point. Per-route
// tests prove the gates someone remembered; this proves there are no others.
// A route added in six months and left ungated fails here, which is the only
// test that can catch it.
var publicRoutes = map[string]bool{
	"GET /healthz": true,
	"GET /readyz":  true,
}

// stubParser is never asked to Parse: every request in this test carries no
// credentials, so RequireBearer refuses at the header check before the
// verifier is ever touched.
type stubParser struct{}

func (stubParser) Parse(context.Context, string) (*authcore.Claims, error) {
	return nil, nil
}

const testProject = "386377229942128837"

// testDeps returns the narrowest Deps that does not panic at NewRouter
// construction time. NewRouter already tolerates a nil Bao; every other
// dependency here stays nil for the same reason — nothing in route
// registration dereferences them, only the handlers they are eventually
// passed to do, and this test never reaches a handler.
func testDeps(t *testing.T) api.Deps {
	t.Helper()
	return api.Deps{
		Config:   config.Config{AllowedOrigins: []string{"http://localhost"}},
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		Verifier: authcore.NewVerifier(stubParser{}, testProject),
	}
}

func TestEveryRouteIsGatedOrExplicitlyPublic(t *testing.T) {
	r := api.NewRouter(testDeps(t))

	for _, route := range r.Routes() {
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
