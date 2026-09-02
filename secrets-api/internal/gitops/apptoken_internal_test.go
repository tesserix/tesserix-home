package gitops

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func testPrivateKeyPEM(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	}))
}

// appStub serves the installation-token exchange and one ordinary API call,
// recording what Authorization header each received and how many times the
// token was minted.
type appStub struct {
	mints    atomic.Int32
	authSeen []string
	expires  func() time.Time
}

func (s *appStub) server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.authSeen = append(s.authSeen, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")

		if strings.HasSuffix(r.URL.Path, "/access_tokens") {
			n := s.mints.Add(1)
			exp := time.Now().Add(time.Hour)
			if s.expires != nil {
				exp = s.expires()
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token":      fmt.Sprintf("ghs_installation_%d", n),
				"expires_at": exp.UTC().Format(time.RFC3339),
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"total_count": 0, "items": []any{}})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func appClient(t *testing.T, srv *httptest.Server) *GitHub {
	t.Helper()
	return NewGitHub(GitHubConfig{
		BaseURL:        srv.URL,
		Owner:          "tesserix",
		Repo:           "tesserix-k8s",
		Branch:         "main",
		AppID:          "123456",
		InstallationID: "7891011",
		AppPrivateKey:  testPrivateKeyPEM(t),
	})
}

// The point of #464: the service must stop acting as a person. When the App is
// configured, requests must carry an INSTALLATION token, never the PAT.
func TestAppIdentityUsesAnInstallationTokenRatherThanAPAT(t *testing.T) {
	stub := &appStub{}
	srv := stub.server(t)
	client := appClient(t, srv)

	if _, err := client.MergedPulls(context.Background(), time.Now().Add(-24*time.Hour)); err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}

	if stub.mints.Load() != 1 {
		t.Fatalf("minted %d times, want 1", stub.mints.Load())
	}
	last := stub.authSeen[len(stub.authSeen)-1]
	if last != "Bearer ghs_installation_1" {
		t.Fatalf("API call carried %q, want the installation token", last)
	}
}

// The mint itself must be authenticated as the APP — a JWT signed with the
// private key, issued by the app id. Anything else and GitHub would reject it.
func TestAppIdentityMintsWithASignedAppJWT(t *testing.T) {
	stub := &appStub{}
	srv := stub.server(t)
	client := appClient(t, srv)

	if _, err := client.MergedPulls(context.Background(), time.Now().Add(-24*time.Hour)); err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}

	mintAuth := stub.authSeen[0]
	raw, ok := strings.CutPrefix(mintAuth, "Bearer ")
	if !ok {
		t.Fatalf("mint carried %q, want a Bearer JWT", mintAuth)
	}
	parsed, _, err := jwt.NewParser().ParseUnverified(raw, jwt.MapClaims{})
	if err != nil {
		t.Fatalf("mint token is not a JWT: %v", err)
	}
	claims := parsed.Claims.(jwt.MapClaims)
	if claims["iss"] != "123456" {
		t.Fatalf("iss = %v, want the app id", claims["iss"])
	}
	if parsed.Method.Alg() != "RS256" {
		t.Fatalf("alg = %s, want RS256", parsed.Method.Alg())
	}
}

// Installation tokens last an hour. Minting one per request would triple the
// latency of every call and burn rate limit for nothing.
func TestAppIdentityReusesAValidToken(t *testing.T) {
	stub := &appStub{}
	srv := stub.server(t)
	client := appClient(t, srv)

	for i := 0; i < 3; i++ {
		if _, err := client.MergedPulls(context.Background(), time.Now().Add(-24*time.Hour)); err != nil {
			t.Fatalf("MergedPulls: %v", err)
		}
	}

	if got := stub.mints.Load(); got != 1 {
		t.Fatalf("minted %d times across 3 calls, want 1", got)
	}
}

// ...but a token near or past expiry must be replaced, or the service starts
// answering 401 an hour after it starts — the failure this design exists to
// avoid.
func TestAppIdentityRemintsAnExpiringToken(t *testing.T) {
	stub := &appStub{expires: func() time.Time { return time.Now().Add(10 * time.Second) }}
	srv := stub.server(t)
	client := appClient(t, srv)

	for i := 0; i < 2; i++ {
		if _, err := client.MergedPulls(context.Background(), time.Now().Add(-24*time.Hour)); err != nil {
			t.Fatalf("MergedPulls: %v", err)
		}
	}

	if got := stub.mints.Load(); got != 2 {
		t.Fatalf("minted %d times, want 2 — a token expiring in 10s must not be reused", got)
	}
}

// Rollback path: with no app configured the PAT behaviour is exactly as before,
// so reverting is a config change rather than a deploy of old code.
func TestStaticTokenIsUsedWhenNoAppIsConfigured(t *testing.T) {
	stub := &appStub{}
	srv := stub.server(t)
	client := NewGitHub(GitHubConfig{
		BaseURL: srv.URL, Owner: "tesserix", Repo: "tesserix-k8s", Branch: "main",
		Token: "ghp_personal_access_token",
	})

	if _, err := client.MergedPulls(context.Background(), time.Now().Add(-24*time.Hour)); err != nil {
		t.Fatalf("MergedPulls: %v", err)
	}

	if stub.mints.Load() != 0 {
		t.Fatalf("minted a token with no app configured")
	}
	if stub.authSeen[0] != "Bearer ghp_personal_access_token" {
		t.Fatalf("carried %q, want the static PAT", stub.authSeen[0])
	}
}

func TestAppIdentityRejectsAnUnreadablePrivateKey(t *testing.T) {
	srv := (&appStub{}).server(t)
	client := NewGitHub(GitHubConfig{
		BaseURL: srv.URL, Owner: "tesserix", Repo: "tesserix-k8s", Branch: "main",
		AppID: "123456", InstallationID: "7891011", AppPrivateKey: "not a pem block",
	})

	_, err := client.MergedPulls(context.Background(), time.Now().Add(-24*time.Hour))
	if err == nil {
		t.Fatal("an unreadable private key must fail loudly, not fall back to an unauthenticated call")
	}
	if !strings.Contains(err.Error(), "private key") {
		t.Fatalf("error %q does not name the private key as the cause", err)
	}
}
