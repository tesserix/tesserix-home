package featureflags

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

type parser struct{ roles []string }

func (p parser) Parse(context.Context, string) (*auth.Claims, error) {
	return &auth.Claims{Subject: "operator-one", ClientID: "console", Audience: []string{"project"}, Issuer: "https://auth.tesserix.app", ExpiresAt: time.Now().Add(time.Hour), Roles: p.roles}, nil
}

func TestEveryFeatureFlagRouteRequiresItsOwnCapabilities(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		roles        []string
		token        bool
		status       int
	}{
		{"GET", "/v1/platform/feature-flags", nil, false, 401},
		{"GET", "/v1/platform/feature-flags", []string{"read"}, true, 403},
		{"GET", "/v1/platform/feature-flags", []string{"platform"}, true, 200},
		{"GET", "/v1/platform/feature-flags/helivanta", []string{"read"}, true, 403},
		{"GET", "/v1/platform/feature-flags/other", []string{"platform"}, true, 404},
		{"GET", "/v1/platform/feature-flags/helivanta/commands", []string{"read"}, true, 403},
		{"POST", "/v1/platform/feature-flags/helivanta/commands", []string{"platform"}, true, 403},
		{"POST", "/v1/platform/feature-flags/helivanta/commands", []string{"manage-feature-flags"}, true, 403},
		{"POST", "/v1/platform/feature-flags/helivanta/commands", []string{"platform", "manage-feature-flags"}, true, 501},
	} {
		t.Run(tc.method+tc.path+strings.Join(tc.roles, ","), func(t *testing.T) {
			mux := http.NewServeMux()
			Register(mux, Config{Verifier: auth.NewVerifier(parser{tc.roles}, "project", auth.WithConsoleClientID("console")), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
			if tc.token {
				req.Header.Set("Authorization", "Bearer header.payload.signature")
			}
			out := httptest.NewRecorder()
			mux.ServeHTTP(out, req)
			if out.Code != tc.status {
				t.Fatalf("expected %d got %d: %s", tc.status, out.Code, out.Body.String())
			}
		})
	}
}
