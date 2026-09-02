package gitops

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The service used to authenticate with a named individual's personal access
// token, which made every pull request it opened appear in Git as that person,
// tied the service's life to their account, and — because that account carried
// admin and an unconditional ruleset bypass — meant branch protection was
// advisory for it rather than binding (#464, #313).
//
// A GitHub App installation fixes all three: the history names the app, the
// credential belongs to the organisation rather than a person, and the app's
// permissions are the only thing it can do.
//
// The cost is that installation tokens expire after an hour, so the token
// cannot be a value read once at startup. It could not have been anyway: the
// deployment injects GITHUB_TOKEN through envFrom, which is evaluated when the
// container starts, so a rotated secret never reaches a running process. That
// is why authentication became a source consulted per request rather than a
// string on the config.

// tokenSource yields the credential for one API call.
type tokenSource interface {
	token(ctx context.Context) (string, error)
}

// staticToken is the personal-access-token path, unchanged. It stays so that
// reverting to a PAT is a configuration change rather than a redeploy of older
// code — the same rollback shape the console's login migration used.
type staticToken string

func (s staticToken) token(context.Context) (string, error) { return string(s), nil }

// appToken mints and caches an installation token for a GitHub App.
type appToken struct {
	appID          string
	installationID string
	privateKeyPEM  string
	baseURL        string
	http           *http.Client

	mu      sync.Mutex
	cached  string
	expires time.Time
}

// expiryGuard is how long before real expiry a cached token is treated as
// spent. A token that is valid when checked but expired when GitHub reads it
// produces a 401 that looks exactly like a misconfigured credential, so the
// guard is generous relative to the hour a token lasts.
const expiryGuard = 5 * time.Minute

func (a *appToken) token(ctx context.Context) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.cached != "" && time.Now().Add(expiryGuard).Before(a.expires) {
		return a.cached, nil
	}

	assertion, err := a.assertion()
	if err != nil {
		return "", err
	}

	url := fmt.Sprintf("%s/app/installations/%s/access_tokens", a.baseURL, a.installationID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+assertion)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := a.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("gitops: minting an installation token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("gitops: minting an installation token: github answered %d", resp.StatusCode)
	}

	var minted struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&minted); err != nil {
		return "", fmt.Errorf("gitops: minting an installation token: %w", err)
	}
	if minted.Token == "" {
		return "", fmt.Errorf("gitops: github returned an empty installation token")
	}

	expires, err := time.Parse(time.RFC3339, minted.ExpiresAt)
	if err != nil {
		// Treating an unparseable expiry as "already spent" would re-mint on
		// every call; treating it as an hour matches what GitHub documents and
		// the guard above still forces a refresh before it bites.
		expires = time.Now().Add(time.Hour)
	}

	a.cached, a.expires = minted.Token, expires
	return a.cached, nil
}

// assertion is the short-lived JWT that proves we hold the app's private key.
// GitHub rejects anything older than ten minutes and anything whose iat is in
// its future, so the window is deliberately narrow and backdated by a minute
// to absorb clock skew between this pod and GitHub.
func (a *appToken) assertion() (string, error) {
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(a.privateKeyPEM))
	if err != nil {
		return "", fmt.Errorf("gitops: reading the app private key: %w", err)
	}

	now := time.Now()
	claims := jwt.RegisteredClaims{
		Issuer:    a.appID,
		IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
		ExpiresAt: jwt.NewNumericDate(now.Add(9 * time.Minute)),
	}

	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
	if err != nil {
		return "", fmt.Errorf("gitops: signing the app assertion: %w", err)
	}
	return signed, nil
}
