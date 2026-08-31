// Package gcpsm drives Google Secret Manager over its REST API. It speaks the
// same write-blind vocabulary as the OpenBao backend: it can create, version,
// disable and destroy a secret, and describe its shape, but nothing here reads
// a payload back.
package gcpsm

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/oauth2/google"

	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

const (
	defaultEndpoint = "https://secretmanager.googleapis.com"
	scope           = "https://www.googleapis.com/auth/cloud-platform"

	// pathSeparator maps a KV path onto a secret id, which may hold only
	// letters, digits, underscore and hyphen. Segments containing it are
	// refused, so the encoding stays reversible.
	pathSeparator = "--"

	// ownerLabel marks the secrets this console created, so they can be told
	// apart from the ones already in the project.
	ownerLabel = "managed-by"
	ownerValue = "secret-service"

	keysAnnotation = "keys"
)

var segmentPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

type Config struct {
	ProjectID string

	// Locations pins replication to named regions; empty asks Google to
	// replicate automatically.
	Locations []string

	Endpoint   string
	HTTPClient *http.Client
}

type Client struct {
	http      *http.Client
	endpoint  string
	project   string
	locations []string
}

// New builds a client. Without an HTTPClient it takes Application Default
// Credentials, which in-cluster means Workload Identity: no key file exists to
// steal.
func New(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.ProjectID) == "" {
		return nil, fmt.Errorf("gcpsm: project id is required")
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		var err error
		if httpClient, err = google.DefaultClient(context.Background(), scope); err != nil {
			return nil, fmt.Errorf("gcpsm: application default credentials: %w", err)
		}
		httpClient.Timeout = 15 * time.Second
	}

	endpoint := cfg.Endpoint
	if endpoint == "" {
		endpoint = defaultEndpoint
	}

	return &Client{
		http:      httpClient,
		endpoint:  strings.TrimRight(endpoint, "/"),
		project:   cfg.ProjectID,
		locations: cfg.Locations,
	}, nil
}

// SecretID encodes a KV path as a Secret Manager secret id.
func SecretID(path string) (string, error) {
	ref, err := secrets.ParseSecretRef(path)
	if err != nil {
		return "", err
	}

	segments := strings.Split(ref.Path(), "/")
	for _, seg := range segments {
		if !segmentPattern.MatchString(seg) {
			return "", fmt.Errorf("gcpsm: %q may hold only letters, digits, hyphen and underscore", seg)
		}
		if strings.Contains(seg, pathSeparator) {
			return "", fmt.Errorf("gcpsm: %q may not contain %q", seg, pathSeparator)
		}
	}
	return strings.Join(segments, pathSeparator), nil
}

// secretID resolves a browsing path to a secret id. Secrets created outside
// this console name no namespace or app, and their id is the whole path.
func secretID(path string) (string, error) {
	clean, err := secrets.CleanSecretPath(path)
	if err != nil {
		return "", err
	}
	if strings.Contains(clean, "/") {
		return SecretID(clean)
	}
	if !segmentPattern.MatchString(clean) {
		return "", fmt.Errorf("gcpsm: %q may hold only letters, digits, hyphen and underscore", clean)
	}
	return clean, nil
}

// secretRef addresses a path, leaving namespace and app empty for the secrets
// that name neither.
func secretRef(path string) (secrets.SecretRef, error) {
	if ref, err := secrets.ParseSecretRef(path); err == nil {
		return ref, nil
	}
	clean, err := secrets.CleanSecretPath(path)
	if err != nil {
		return secrets.SecretRef{}, err
	}
	if strings.Contains(clean, "/") {
		_, err := secrets.ParseSecretRef(path)
		return secrets.SecretRef{}, err
	}
	return secrets.SecretRef{Name: clean}, nil
}

// PathFromSecretID reverses SecretID.
func PathFromSecretID(id string) string {
	return strings.Join(strings.Split(id, pathSeparator), "/")
}

func (c *Client) List(ctx context.Context, prefix string) ([]secrets.Entry, error) {
	clean := strings.Trim(strings.TrimSpace(prefix), "/")
	if clean != "" {
		var err error
		if clean, err = secrets.CleanSecretPath(clean); err != nil {
			return nil, err
		}
	}

	paths, err := c.paths(ctx)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	entries := make([]secrets.Entry, 0, len(paths))
	for _, path := range paths {
		rest, ok := childOf(path, clean)
		if !ok {
			continue
		}
		name, isFolder := rest, false
		if head, _, cut := strings.Cut(rest, "/"); cut {
			name, isFolder = head, true
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		entries = append(entries, secrets.Entry{Name: name, IsFolder: isFolder})
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, nil
}

// childOf returns the part of path below prefix, and whether path sits there.
func childOf(path, prefix string) (string, bool) {
	if prefix == "" {
		return path, true
	}
	rest, ok := strings.CutPrefix(path, prefix+"/")
	return rest, ok && rest != ""
}

func (c *Client) Describe(ctx context.Context, path string) (secrets.Secret, error) {
	ref, err := secretRef(path)
	if err != nil {
		return secrets.Secret{}, err
	}
	id, err := secretID(path)
	if err != nil {
		return secrets.Secret{}, err
	}

	var meta secretResource
	if err := c.do(ctx, http.MethodGet, c.secretURL(id), nil, &meta); err != nil {
		return secrets.Secret{}, err
	}

	versions, err := c.Versions(ctx, path)
	if err != nil {
		return secrets.Secret{}, err
	}

	secret := secrets.Secret{
		Ref:       ref,
		Path:      PathFromSecretID(id),
		Keys:      []string{},
		CreatedAt: parseTime(meta.CreateTime),
	}
	if joined := meta.Annotations[keysAnnotation]; joined != "" {
		secret.Keys = strings.Split(joined, ",")
	}
	for _, v := range versions {
		if !v.Deleted && !v.Destroyed {
			secret.Version = v.Version
			secret.UpdatedAt = v.CreatedAt
			break
		}
	}
	return secret, nil
}

// Write adds a version, creating the secret on first use. The payload is a
// JSON object so External Secrets can pull one key out of it by property.
//
// A flat secret — one created outside this console, addressed by its bare id —
// holds its value directly, and is updated in place rather than created.
//
// Secret Manager has no check-and-set, so a positive ifVersion is enforced by
// comparing it with the newest live version first. That leaves a race no API
// call can close here — it still turns the common case, two administrators
// editing the same secret minutes apart, from a silent overwrite into an error.
func (c *Client) Write(ctx context.Context, path string, data map[string]string, ifVersion int) (int, error) {
	ref, err := secretRef(path)
	if err != nil {
		return 0, err
	}
	id, err := secretID(path)
	if err != nil {
		return 0, err
	}
	if len(data) == 0 {
		return 0, fmt.Errorf("gcpsm: refusing to write a secret with no keys")
	}
	if err := c.checkVersion(ctx, path, ifVersion); err != nil {
		return 0, err
	}
	if ref.Namespace == "" || ref.App == "" {
		return c.writeFlat(ctx, id, data)
	}

	keys := make([]string, 0, len(data))
	for k := range data {
		if strings.TrimSpace(k) == "" {
			return 0, fmt.Errorf("gcpsm: secret keys may not be blank")
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	joined := strings.Join(keys, ",")

	if err := c.ensureSecret(ctx, id, ref, joined); err != nil {
		return 0, err
	}

	payload, err := json.Marshal(data)
	if err != nil {
		return 0, fmt.Errorf("gcpsm: encode payload: %w", err)
	}

	var added versionResource
	body := map[string]any{"payload": map[string]any{"data": base64.StdEncoding.EncodeToString(payload)}}
	if err := c.do(ctx, http.MethodPost, c.secretURL(id)+":addVersion", body, &added); err != nil {
		return 0, err
	}
	return versionNumber(added.Name), nil
}

// writeFlat rotates a secret this console did not create. Its payload is the
// value itself, with no JSON wrapper and no keys annotation: adding either
// would break every ExternalSecret that reads it without a property.
func (c *Client) writeFlat(ctx context.Context, id string, data map[string]string) (int, error) {
	value, ok := data[secrets.FlatValueKey]
	if !ok || len(data) != 1 {
		return 0, fmt.Errorf("gcpsm: %s holds a single value; write it as %q and nothing else", id, secrets.FlatValueKey)
	}
	if err := c.do(ctx, http.MethodGet, c.secretURL(id), nil, nil); err != nil {
		if errors.Is(err, secrets.ErrNotFound) {
			return 0, fmt.Errorf("gcpsm: %s does not exist; create a secret as <namespace>/<app>/<name>", id)
		}
		return 0, err
	}

	var added versionResource
	body := map[string]any{"payload": map[string]any{"data": base64.StdEncoding.EncodeToString([]byte(value))}}
	if err := c.do(ctx, http.MethodPost, c.secretURL(id)+":addVersion", body, &added); err != nil {
		return 0, err
	}
	return versionNumber(added.Name), nil
}

func (c *Client) ensureSecret(ctx context.Context, id string, ref secrets.SecretRef, keys string) error {
	err := c.do(ctx, http.MethodGet, c.secretURL(id), nil, nil)
	switch {
	case err == nil:
		update := map[string]any{"annotations": map[string]string{keysAnnotation: keys}}
		return c.do(ctx, http.MethodPatch, c.secretURL(id)+"?updateMask=annotations", update, nil)
	case !errors.Is(err, secrets.ErrNotFound):
		return err
	}

	create := map[string]any{
		"replication": c.replication(),
		"labels": map[string]string{
			ownerLabel:  ownerValue,
			"namespace": ref.Namespace,
			"app":       ref.App,
		},
		"annotations": map[string]string{keysAnnotation: keys},
	}
	return c.do(ctx, http.MethodPost, c.secretsURL()+"?secretId="+url.QueryEscape(id), create, nil)
}

func (c *Client) replication() map[string]any {
	if len(c.locations) == 0 {
		return map[string]any{"automatic": map[string]any{}}
	}
	replicas := make([]map[string]string, 0, len(c.locations))
	for _, location := range c.locations {
		replicas = append(replicas, map[string]string{"location": location})
	}
	return map[string]any{"userManaged": map[string]any{"replicas": replicas}}
}

// Delete disables the newest live version; earlier versions and the secret
// itself survive, which is what OpenBao's soft delete does.
func (c *Client) Delete(ctx context.Context, path string) error {
	id, err := secretID(path)
	if err != nil {
		return err
	}
	versions, err := c.Versions(ctx, path)
	if err != nil {
		return err
	}
	for _, v := range versions {
		if v.Deleted || v.Destroyed {
			continue
		}
		return c.do(ctx, http.MethodPost, fmt.Sprintf("%s/versions/%d:disable", c.secretURL(id), v.Version), map[string]any{}, nil)
	}
	return fmt.Errorf("%w: %s has no live version", secrets.ErrNotFound, path)
}

func (c *Client) checkVersion(ctx context.Context, path string, ifVersion int) error {
	if ifVersion <= 0 {
		return nil
	}
	versions, err := c.Versions(ctx, path)
	if err != nil {
		return err
	}
	for _, v := range versions {
		if v.Deleted || v.Destroyed {
			continue
		}
		if v.Version != ifVersion {
			return fmt.Errorf("%w: %s is at version %d, not %d", secrets.ErrConflict, path, v.Version, ifVersion)
		}
		return nil
	}
	return fmt.Errorf("%w: %s has no live version to replace", secrets.ErrConflict, path)
}

// Health proves the project is reachable and the credential may list it. One
// secret is enough; the console never needs the page itself.
func (c *Client) Health(ctx context.Context) error {
	return c.do(ctx, http.MethodGet, c.secretsURL()+"?pageSize=1", nil, nil)
}

// Restore re-enables a disabled version, reversing a delete. A destroyed
// version cannot come back, and Secret Manager refuses it.
func (c *Client) Restore(ctx context.Context, path string, version int) error {
	id, err := secretID(path)
	if err != nil {
		return err
	}
	if version <= 0 {
		return fmt.Errorf("gcpsm: restore needs the version number to bring back")
	}
	return c.do(ctx, http.MethodPost, fmt.Sprintf("%s/versions/%d:enable", c.secretURL(id), version), map[string]any{}, nil)
}

// Destroy removes the secret and every version of it. This is irreversible.
func (c *Client) Destroy(ctx context.Context, path string) error {
	id, err := secretID(path)
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodDelete, c.secretURL(id), nil, nil)
}

func (c *Client) Versions(ctx context.Context, path string) ([]secrets.Version, error) {
	id, err := secretID(path)
	if err != nil {
		return nil, err
	}

	var page struct {
		Versions      []versionResource `json:"versions"`
		NextPageToken string            `json:"nextPageToken"`
	}

	out := make([]secrets.Version, 0, 8)
	token := ""
	for {
		listURL := fmt.Sprintf("%s/versions?pageSize=100", c.secretURL(id))
		if token != "" {
			listURL += "&pageToken=" + url.QueryEscape(token)
		}
		page.Versions, page.NextPageToken = nil, ""
		if err := c.do(ctx, http.MethodGet, listURL, nil, &page); err != nil {
			return nil, err
		}
		for _, v := range page.Versions {
			out = append(out, secrets.Version{
				Version:   versionNumber(v.Name),
				CreatedAt: parseTime(v.CreateTime),
				Deleted:   v.State == "DISABLED",
				Destroyed: v.State == "DESTROYED",
			})
		}
		if page.NextPageToken == "" {
			break
		}
		token = page.NextPageToken
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Version > out[j].Version })
	return out, nil
}

// paths lists every secret in the project as a KV path. Secrets created
// outside the console are listed too — an admin browsing the store expects to
// see what is actually in it.
func (c *Client) paths(ctx context.Context) ([]string, error) {
	var page struct {
		Secrets       []secretResource `json:"secrets"`
		NextPageToken string           `json:"nextPageToken"`
	}

	out := make([]string, 0, 32)
	token := ""
	for {
		listURL := c.secretsURL() + "?pageSize=100"
		if token != "" {
			listURL += "&pageToken=" + url.QueryEscape(token)
		}
		page.Secrets, page.NextPageToken = nil, ""
		if err := c.do(ctx, http.MethodGet, listURL, nil, &page); err != nil {
			return nil, err
		}
		for _, s := range page.Secrets {
			if id := lastSegment(s.Name); id != "" {
				out = append(out, PathFromSecretID(id))
			}
		}
		if page.NextPageToken == "" {
			break
		}
		token = page.NextPageToken
	}
	return out, nil
}

type secretResource struct {
	Name        string            `json:"name"`
	CreateTime  string            `json:"createTime"`
	Annotations map[string]string `json:"annotations"`
}

type versionResource struct {
	Name       string `json:"name"`
	State      string `json:"state"`
	CreateTime string `json:"createTime"`
}

func (c *Client) secretsURL() string         { return c.endpoint + "/v1/projects/" + c.project + "/secrets" }
func (c *Client) secretURL(id string) string { return c.secretsURL() + "/" + id }

// do sends one request and decodes into out when it is not nil. Google's own
// error text never reaches the caller: it names IAM permissions and resource
// paths that belong in the audit log, not in a browser.
func (c *Client) do(ctx context.Context, method, endpoint string, body, out any) error {
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("gcpsm: encode request: %w", err)
		}
		reader = bytes.NewReader(raw)
	}

	var req *http.Request
	var err error
	if reader != nil {
		req, err = http.NewRequestWithContext(ctx, method, endpoint, reader)
	} else {
		req, err = http.NewRequestWithContext(ctx, method, endpoint, nil)
	}
	if err != nil {
		return fmt.Errorf("gcpsm: request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("gcpsm: %s: %w", method, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return statusError(resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("gcpsm: decode response: %w", err)
	}
	return nil
}

func statusError(status int) error {
	switch status {
	case http.StatusNotFound:
		return secrets.ErrNotFound
	case http.StatusUnauthorized, http.StatusForbidden:
		return secrets.ErrForbidden
	default:
		return fmt.Errorf("gcpsm: secret manager returned %d", status)
	}
}

func versionNumber(name string) int {
	n, err := strconv.Atoi(lastSegment(name))
	if err != nil {
		return 0
	}
	return n
}

func lastSegment(name string) string {
	idx := strings.LastIndex(name, "/")
	if idx < 0 {
		return name
	}
	return name[idx+1:]
}

func parseTime(raw string) time.Time {
	if raw == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}
	}
	return t
}
