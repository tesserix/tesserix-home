package auth_test

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
)

func newFlow(t *testing.T) *auth.Flow {
	t.Helper()
	f, err := auth.NewFlow(context.Background(), auth.FlowConfig{
		ClientID:     "1234.apps.googleusercontent.com",
		ClientSecret: "shhh",
		RedirectURL:  "https://secret-service.tesserix.app/api/auth/callback",
	})
	if err != nil {
		t.Fatalf("NewFlow: %v", err)
	}
	return f
}

func TestAuthCodeURLSendsTheBrowserToGoogle(t *testing.T) {
	raw := newFlow(t).AuthCodeURL("state-123", auth.PKCE{Challenge: "chal", Method: "S256"})

	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("AuthCodeURL produced an unparsable URL: %v", err)
	}
	if u.Host != "accounts.google.com" {
		t.Fatalf("AuthCodeURL host = %q, want accounts.google.com", u.Host)
	}

	q := u.Query()
	for field, want := range map[string]string{
		"client_id":             "1234.apps.googleusercontent.com",
		"response_type":         "code",
		"state":                 "state-123",
		"code_challenge":        "chal",
		"code_challenge_method": "S256",
		"redirect_uri":          "https://secret-service.tesserix.app/api/auth/callback",
	} {
		if got := q.Get(field); got != want {
			t.Errorf("%s = %q, want %q", field, got, want)
		}
	}
	if scope := q.Get("scope"); !strings.Contains(scope, "openid") || !strings.Contains(scope, "email") {
		t.Errorf("scope = %q, want it to request openid and email", scope)
	}
}

// Two administrators share machines with personal Google accounts, so the
// account chooser must appear rather than silently reusing whoever is signed in.
func TestAuthCodeURLForcesTheAccountChooser(t *testing.T) {
	raw := newFlow(t).AuthCodeURL("state-123", auth.PKCE{Challenge: "chal"})

	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("AuthCodeURL produced an unparsable URL: %v", err)
	}
	if got := u.Query().Get("prompt"); got != "select_account" {
		t.Errorf("prompt = %q, want select_account", got)
	}
}

func TestAuthCodeURLDefaultsChallengeMethodToS256(t *testing.T) {
	raw := newFlow(t).AuthCodeURL("state-123", auth.PKCE{Challenge: "chal"})

	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("AuthCodeURL produced an unparsable URL: %v", err)
	}
	if got := u.Query().Get("code_challenge_method"); got != "S256" {
		t.Errorf("code_challenge_method = %q, want S256", got)
	}
}

func TestTokenEndpointIsGoogles(t *testing.T) {
	if got := newFlow(t).TokenURL(); got != "https://oauth2.googleapis.com/token" {
		t.Fatalf("TokenURL = %q, want Google's token endpoint", got)
	}
}

func TestNewFlowRequiresClientAndRedirect(t *testing.T) {
	cases := map[string]auth.FlowConfig{
		"no client id":     {ClientSecret: "y", RedirectURL: "https://a/b"},
		"no client secret": {ClientID: "x", RedirectURL: "https://a/b"},
		"no redirect":      {ClientID: "x", ClientSecret: "y"},
	}

	for name, cfg := range cases {
		if _, err := auth.NewFlow(context.Background(), cfg); err == nil {
			t.Errorf("NewFlow(%s) succeeded, want error", name)
		}
	}
}
