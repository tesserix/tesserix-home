// Package github is the repos module's GitHub REST client: a GitHub App
// installation token, and the handful of calls the module makes with it.
//
// Hand-rolled rather than a client library for the reason the module gives:
// six endpoints, and the only non-trivial part — minting an installation
// token — is an RS256 JWT the standard library signs in twenty lines.
// secrets-api has the same minter (internal/gitops/apptoken.go) but lives
// under a different module root, so Go's internal/ rule forbids importing it.
package github

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// DefaultBaseURL is GitHub's REST API.
const DefaultBaseURL = "https://api.github.com"

// maxBody bounds what one response may cost this process. The org's repository
// list is the largest page read, at ~5 KiB a repository and 100 per page.
const maxBody = 4 << 20

// expiryGuard is how long before real expiry a cached token is treated as
// spent — the same margin, and the same reason, as secrets-api's minter.
const expiryGuard = 5 * time.Minute

// Config is the GitHub App this client authenticates as.
type Config struct {
	AppID          string
	InstallationID string
	PrivateKeyPEM  string
	Org            string
	// BaseURL is overridable for tests. Empty means DefaultBaseURL.
	BaseURL string
}

// Enabled reports whether an App is configured at all. A half-configured App
// is still "enabled" — New refuses it, so the deployment fails at startup
// rather than answering 501 and hiding a typo'd variable.
func (c Config) Enabled() bool {
	return c.AppID != "" || c.InstallationID != "" || c.PrivateKeyPEM != ""
}

// StatusError is a non-2xx answer from GitHub.
type StatusError struct {
	Status int
	// Message is GitHub's own `message` field. It is GitHub's prose, not a
	// transport error, so it carries no hostnames and is safe to show an
	// operator — "Visibility can't be changed for forks" is the sentence they
	// need, and nothing this service could write would be better.
	Message string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("github answered %d: %s", e.Status, e.Message)
}

// StatusOf reports the GitHub status behind err, if there is one.
func StatusOf(err error) (int, bool) {
	var status *StatusError
	if errors.As(err, &status) {
		return status.Status, true
	}
	return 0, false
}

// Client calls GitHub as one App installation.
type Client struct {
	cfg  Config
	key  *rsa.PrivateKey
	http *http.Client

	mu      sync.Mutex
	token   string
	expires time.Time
}

// New builds a client. The key is parsed here rather than per request, so a
// malformed key is a startup failure rather than every request's.
func New(cfg Config, httpClient *http.Client) (*Client, error) {
	if cfg.AppID == "" || cfg.InstallationID == "" || cfg.PrivateKeyPEM == "" || cfg.Org == "" {
		return nil, errors.New("github: app id, installation id, private key and org are all required")
	}
	key, err := parseKey(cfg.PrivateKeyPEM)
	if err != nil {
		return nil, err
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultBaseURL
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{cfg: cfg, key: key, http: httpClient}, nil
}

// Org is the organisation this client reads.
func (c *Client) Org() string { return c.cfg.Org }

// pemArmor matches a PEM block whose line breaks were lost: the console's
// Secrets value field is a single-line input, and a browser drops the newlines
// of a key pasted into one.
var pemArmor = regexp.MustCompile(`-----BEGIN ([A-Z ]+)-----(.*?)-----END ([A-Z ]+)-----`)

// parseKey reads a GitHub App key, which GitHub issues as PKCS#1 but which a
// re-exported key may carry as PKCS#8.
func parseKey(pemText string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		block = rewrapPEM(pemText)
	}
	if block == nil {
		return nil, errors.New("github: the app private key is not PEM")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("github: reading the app private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("github: the app private key is not RSA")
	}
	return key, nil
}

// rewrapPEM recovers a PEM block flattened to one line, its newlines removed
// or turned into spaces. The base64 body carries no whitespace of its own, so
// dropping all of it restores the bytes exactly.
func rewrapPEM(text string) *pem.Block {
	m := pemArmor.FindStringSubmatch(text)
	if m == nil || m[1] != m[3] {
		return nil
	}
	der, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(m[2]), ""))
	if err != nil {
		return nil
	}
	return &pem.Block{Type: m[1], Bytes: der}
}

// assertion is the App JWT. Backdated a minute for clock skew, and inside the
// ten minutes GitHub accepts.
func (c *Client) assertion() (string, error) {
	now := time.Now()
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{
		"iss": c.cfg.AppID,
		"iat": now.Add(-time.Minute).Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
	})
	if err != nil {
		return "", err
	}
	signing := header + "." + enc.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, c.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("github: signing the app assertion: %w", err)
	}
	return signing + "." + enc.EncodeToString(sig), nil
}

// installationToken mints, or reuses, the installation token.
func (c *Client) installationToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Add(expiryGuard).Before(c.expires) {
		return c.token, nil
	}

	assertion, err := c.assertion()
	if err != nil {
		return "", err
	}
	var minted struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	path := "/app/installations/" + url.PathEscape(c.cfg.InstallationID) + "/access_tokens"
	if _, err := c.send(ctx, http.MethodPost, c.cfg.BaseURL+path, "Bearer "+assertion, nil, &minted); err != nil {
		return "", fmt.Errorf("github: minting an installation token: %w", err)
	}
	if minted.Token == "" {
		return "", errors.New("github: minting an installation token: empty token")
	}
	c.token, c.expires = minted.Token, minted.ExpiresAt
	if c.expires.IsZero() {
		c.expires = time.Now().Add(time.Hour)
	}
	return c.token, nil
}

// do makes one authenticated call. out may be nil.
func (c *Client) do(ctx context.Context, method, target string, body, out any) (*http.Response, error) {
	token, err := c.installationToken(ctx)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(target, "/") {
		target = c.cfg.BaseURL + target
	}
	return c.send(ctx, method, target, "Bearer "+token, body, out)
}

func (c *Client) send(ctx context.Context, method, target, authorization string, body, out any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = strings.NewReader(string(encoded))
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", authorization)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return resp, err
	}
	if resp.StatusCode >= 300 {
		var refusal struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &refusal)
		return resp, &StatusError{Status: resp.StatusCode, Message: refusal.Message}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp, fmt.Errorf("github: decoding %s %s: %w", method, req.URL.Path, err)
		}
	}
	return resp, nil
}

// nextLink matches the rel="next" entry of a Link header. GitHub paginates
// some endpoints by page and some by cursor; following the link it hands back
// is the one approach that works for both.
var nextLink = regexp.MustCompile(`<([^>]+)>;\s*rel="next"`)

// pages bounds every listing. 100 a page, so 50 pages is 5,000 items — far
// past this org, and a hard stop if a cursor ever loops.
const pages = 50

// list reads every page of a listing into out.
func list[T any](ctx context.Context, c *Client, path string) ([]T, error) {
	var all []T
	target := path
	for range pages {
		var page []T
		resp, err := c.do(ctx, http.MethodGet, target, nil, &page)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		match := nextLink.FindStringSubmatch(resp.Header.Get("Link"))
		if match == nil {
			return all, nil
		}
		// Only ever follow a link back to the same API. A Link header naming
		// another host would otherwise receive the installation token.
		if !strings.HasPrefix(match[1], c.cfg.BaseURL+"/") {
			return nil, fmt.Errorf("github: refusing a pagination link off %s", c.cfg.BaseURL)
		}
		target = match[1]
	}
	return nil, fmt.Errorf("github: %s ran past %d pages", path, pages)
}

// Repo is the subset of GitHub's repository object this module reads.
type Repo struct {
	Name          string     `json:"name"`
	HTMLURL       string     `json:"html_url"`
	Description   *string    `json:"description"`
	Visibility    string     `json:"visibility"`
	Archived      bool       `json:"archived"`
	Fork          bool       `json:"fork"`
	DefaultBranch string     `json:"default_branch"`
	Language      *string    `json:"language"`
	PushedAt      *time.Time `json:"pushed_at"`
	Stars         int        `json:"stargazers_count"`
}

// Repos lists every repository in the org.
func (c *Client) Repos(ctx context.Context) ([]Repo, error) {
	return list[Repo](ctx, c, "/orgs/"+url.PathEscape(c.cfg.Org)+"/repos?type=all&per_page=100")
}

// Repo reads one repository.
func (c *Client) Repo(ctx context.Context, name string) (Repo, error) {
	var repo Repo
	_, err := c.do(ctx, http.MethodGet, c.repoPath(name), nil, &repo)
	return repo, err
}

// UpdateRepo patches one repository and returns its new state.
func (c *Client) UpdateRepo(ctx context.Context, name string, patch map[string]any) (Repo, error) {
	var repo Repo
	_, err := c.do(ctx, http.MethodPatch, c.repoPath(name), patch, &repo)
	return repo, err
}

func (c *Client) repoPath(name string) string {
	return "/repos/" + url.PathEscape(c.cfg.Org) + "/" + url.PathEscape(name)
}

// Alert is one open security alert, reduced to what is counted.
type Alert struct {
	Repository struct {
		Name string `json:"name"`
	} `json:"repository"`
	// SecurityAdvisory is present on Dependabot alerts only.
	SecurityAdvisory *struct {
		Severity string `json:"severity"`
	} `json:"security_advisory"`
}

// DependabotAlerts lists the org's open Dependabot alerts.
func (c *Client) DependabotAlerts(ctx context.Context) ([]Alert, error) {
	return list[Alert](ctx, c, "/orgs/"+url.PathEscape(c.cfg.Org)+"/dependabot/alerts?state=open&per_page=100")
}

// SecretScanningAlerts lists the org's open secret-scanning alerts.
func (c *Client) SecretScanningAlerts(ctx context.Context) ([]Alert, error) {
	return list[Alert](ctx, c, "/orgs/"+url.PathEscape(c.cfg.Org)+"/secret-scanning/alerts?state=open&per_page=100")
}

// BranchProtected reports whether a branch is protected.
//
// Read from the protection endpoint, which the App's Administration permission
// covers, not from the branch itself: reading a private repository's branch
// needs Contents, which would hand this App every line of private code to
// learn one boolean. GitHub answers 404 "Branch not protected" for no, 404 for
// a branch that does not exist (an empty repository), and 403 for a private
// repository on GitHub Free, which has no protection at all.
func (c *Client) BranchProtected(ctx context.Context, repo, branch string) (bool, error) {
	_, err := c.do(ctx, http.MethodGet, c.repoPath(repo)+"/branches/"+url.PathEscape(branch)+"/protection", nil, nil)
	var status *StatusError
	if errors.As(err, &status) && status.Status == http.StatusNotFound && status.Message == "Branch not protected" {
		return false, nil
	}
	return err == nil, err
}

// DependabotEnabled reports whether Dependabot alerts are on for a repository.
// GitHub answers 204 for on and 404 for off, so a 404 here is an answer, not
// a failure.
func (c *Client) DependabotEnabled(ctx context.Context, repo string) (bool, error) {
	_, err := c.do(ctx, http.MethodGet, c.repoPath(repo)+"/vulnerability-alerts", nil, nil)
	if status, ok := StatusOf(err); ok && status == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}
