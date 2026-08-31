package bao

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

// grantPrefix namespaces the objects this service owns, so a role created here
// is never confused with one the OpenBao bootstrap Job manages.
const grantPrefix = "app-"

// grantSeparator joins the namespace and app into one object name. It is an
// underscore because a DNS label cannot contain one, so the name splits back
// unambiguously; a hyphen would not.
const grantSeparator = "_"

// denylistPath holds one metadata entry per namespace that must never be
// granted. It lives under kv/metadata, never kv/data: this service holds no
// read capability on kv/data and could not read its own entries back.
const denylistPath = "_control/denylist"

// periodicTokenPeriod is the renewal window of a grant with no expiry.
const periodicTokenPeriod = "24h"

// Grant is one app's read access to its own KV prefix, kv/<namespace>/<app>/*.
// Isolation is per app rather than per namespace so that two services sharing a
// namespace cannot read each other's secrets. It is realised as an OpenBao
// policy plus a Kubernetes auth role, both named app-<namespace>_<app>.
type Grant struct {
	Namespace      string `json:"namespace"`
	App            string `json:"app"`
	ServiceAccount string `json:"serviceAccount"`
	TTL            string `json:"ttl,omitempty"`
	// SecretPrefix is where the app's secrets live, for display and for the
	// ExternalSecret the console hands the administrator.
	SecretPrefix string `json:"secretPrefix,omitempty"`
}

func grantName(namespace, app string) string {
	return grantPrefix + namespace + grantSeparator + app
}

// splitGrantName reverses grantName; ok is false for a role this service does
// not own.
func splitGrantName(name string) (namespace, app string, ok bool) {
	trimmed, found := strings.CutPrefix(name, grantPrefix)
	if !found {
		return "", "", false
	}
	namespace, app, found = strings.Cut(trimmed, grantSeparator)
	if !found || namespace == "" || app == "" {
		return "", "", false
	}
	return namespace, app, true
}

type DenyEntry struct {
	Namespace string    `json:"namespace"`
	Reason    string    `json:"reason"`
	DeniedBy  string    `json:"deniedBy"`
	DeniedAt  time.Time `json:"deniedAt,omitempty"`
}

func (c *Client) Grant(ctx context.Context, g Grant) error {
	if err := secrets.ValidateNamespace(g.Namespace); err != nil {
		return err
	}
	if !secrets.IsDNSLabel(g.App) {
		return fmt.Errorf("bao: %q is not a valid app name", g.App)
	}
	if strings.Contains(g.ServiceAccount, "*") {
		return errors.New("bao: a wildcard ServiceAccount would grant every pod in the namespace")
	}
	if !secrets.IsDNSLabel(g.ServiceAccount) {
		return fmt.Errorf("bao: %q is not a valid ServiceAccount name", g.ServiceAccount)
	}
	if g.TTL == "" {
		g.TTL = "1h"
	}

	denied, err := c.isDenied(ctx, g.Namespace)
	if err != nil {
		return err
	}
	if denied {
		return fmt.Errorf("bao: namespace %q is on the denylist", g.Namespace)
	}

	name := grantName(g.Namespace, g.App)
	prefix := g.Namespace + "/" + g.App
	policy := fmt.Sprintf(
		"path %q { capabilities = [\"read\"] }\npath %q { capabilities = [\"read\", \"list\"] }\n",
		fmt.Sprintf("%s/data/%s/*", c.mount, prefix),
		fmt.Sprintf("%s/metadata/%s/*", c.mount, prefix),
	)

	if _, err := c.write(ctx, "sys/policies/acl/"+name, map[string]any{"policy": policy}); err != nil {
		return fmt.Errorf("bao: write policy %s: %w", name, err)
	}

	role := map[string]any{
		"bound_service_account_names":      g.ServiceAccount,
		"bound_service_account_namespaces": g.Namespace,
		"token_policies":                   name,
		"token_ttl":                        g.TTL,
	}
	// "0" is the console's "never expires". A periodic token renews for as long
	// as the grant stands, and dies with it, where an infinite one would outlive it.
	if g.TTL == "0" {
		role["token_ttl"] = periodicTokenPeriod
		role["token_period"] = periodicTokenPeriod
	}
	if _, err := c.write(ctx, c.rolePath(name), role); err != nil {
		return fmt.Errorf("bao: write role %s: %w", name, err)
	}
	// The role is the grant. A write the raft leader acknowledged but did not
	// store would leave the console reporting access no app actually has.
	if _, err := c.read(ctx, c.rolePath(name)); err != nil {
		return fmt.Errorf("bao: role %s did not persist: %w", name, err)
	}
	return nil
}

// AppRef names one workload and the ServiceAccount it runs as.
type AppRef struct {
	Name           string `json:"name" binding:"required"`
	ServiceAccount string `json:"serviceAccount" binding:"required"`
}

// GrantAll binds several apps in one namespace on the same terms. It stops at
// the first failure and returns the grants already made, so the caller can
// report what stands rather than guessing.
func (c *Client) GrantAll(ctx context.Context, namespace, ttl string, apps []AppRef) ([]Grant, error) {
	granted := make([]Grant, 0, len(apps))
	for _, app := range apps {
		g := Grant{
			Namespace:      namespace,
			App:            app.Name,
			ServiceAccount: app.ServiceAccount,
			TTL:            ttl,
			SecretPrefix:   namespace + "/" + app.Name,
		}
		if err := c.Grant(ctx, g); err != nil {
			return granted, err
		}
		granted = append(granted, g)
	}
	return granted, nil
}

func (c *Client) Revoke(ctx context.Context, namespace, app string) error {
	if err := secrets.ValidateNamespace(namespace); err != nil {
		return err
	}
	if !secrets.IsDNSLabel(app) {
		return fmt.Errorf("bao: %q is not a valid app name", app)
	}
	name := grantName(namespace, app)

	if err := c.delete(ctx, c.rolePath(name)); err != nil && !errors.Is(err, secrets.ErrNotFound) {
		return fmt.Errorf("bao: delete role %s: %w", name, err)
	}
	if err := c.delete(ctx, "sys/policies/acl/"+name); err != nil && !errors.Is(err, secrets.ErrNotFound) {
		return fmt.Errorf("bao: delete policy %s: %w", name, err)
	}
	return nil
}

func (c *Client) Grants(ctx context.Context) ([]Grant, error) {
	names, err := c.listKeys(ctx, c.rolePath(""))
	if err != nil {
		if errors.Is(err, secrets.ErrNotFound) {
			return []Grant{}, nil
		}
		return nil, err
	}

	grants := make([]Grant, 0, len(names))
	for _, name := range names {
		namespace, app, ok := splitGrantName(strings.TrimSuffix(name, "/"))
		if !ok {
			continue
		}
		resp, err := c.read(ctx, c.rolePath(name))
		if err != nil {
			if errors.Is(err, secrets.ErrNotFound) {
				continue
			}
			return nil, err
		}

		g := Grant{
			Namespace:    namespace,
			App:          app,
			TTL:          fmt.Sprint(resp["token_ttl"]),
			SecretPrefix: c.mount + "/" + namespace + "/" + app,
		}
		if sas := stringsFrom(resp["bound_service_account_names"]); len(sas) > 0 {
			g.ServiceAccount = sas[0]
		}
		grants = append(grants, g)
	}
	sort.Slice(grants, func(i, j int) bool {
		if grants[i].Namespace != grants[j].Namespace {
			return grants[i].Namespace < grants[j].Namespace
		}
		return grants[i].App < grants[j].App
	})
	return grants, nil
}

// GrantsFor returns the grants held by one namespace.
func (c *Client) GrantsFor(ctx context.Context, namespace string) ([]Grant, error) {
	all, err := c.Grants(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Grant, 0, len(all))
	for _, g := range all {
		if g.Namespace == namespace {
			out = append(out, g)
		}
	}
	return out, nil
}

// Deny blocks a namespace and tears down any grant it already holds, so that
// denylisting takes effect immediately rather than at the next token renewal.
func (c *Client) Deny(ctx context.Context, namespace, reason, actor string) error {
	if err := secrets.ValidateNamespace(namespace); err != nil {
		return err
	}
	if strings.TrimSpace(reason) == "" {
		return errors.New("bao: a denylist entry must record a reason")
	}

	entry := map[string]any{
		"reason":   reason,
		"deniedBy": actor,
		"deniedAt": time.Now().UTC().Format(time.RFC3339),
	}
	if _, err := c.write(ctx, c.metadataPath(denylistPath+"/"+namespace), map[string]any{"custom_metadata": entry}); err != nil {
		return fmt.Errorf("bao: write denylist entry: %w", err)
	}

	grants, err := c.GrantsFor(ctx, namespace)
	if err != nil {
		return err
	}
	for _, g := range grants {
		if err := c.Revoke(ctx, g.Namespace, g.App); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) Allow(ctx context.Context, namespace string) error {
	if err := secrets.ValidateNamespace(namespace); err != nil {
		return err
	}
	if err := c.delete(ctx, c.metadataPath(denylistPath+"/"+namespace)); err != nil && !errors.Is(err, secrets.ErrNotFound) {
		return fmt.Errorf("bao: delete denylist entry: %w", err)
	}
	return nil
}

func (c *Client) Denied(ctx context.Context) ([]DenyEntry, error) {
	names, err := c.listKeys(ctx, c.metadataPath(denylistPath))
	if err != nil {
		if errors.Is(err, secrets.ErrNotFound) {
			return []DenyEntry{}, nil
		}
		return nil, err
	}

	entries := make([]DenyEntry, 0, len(names))
	for _, name := range names {
		name = strings.TrimSuffix(name, "/")
		entry := DenyEntry{Namespace: name}

		resp, err := c.read(ctx, c.metadataPath(denylistPath+"/"+name))
		if err == nil {
			if custom, ok := resp["custom_metadata"].(map[string]any); ok {
				entry.Reason, _ = custom["reason"].(string)
				entry.DeniedBy, _ = custom["deniedBy"].(string)
				entry.DeniedAt = timeFrom(custom["deniedAt"])
			}
		} else if !errors.Is(err, secrets.ErrNotFound) {
			return nil, err
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Namespace < entries[j].Namespace })
	return entries, nil
}

func (c *Client) isDenied(ctx context.Context, namespace string) (bool, error) {
	names, err := c.listKeys(ctx, c.metadataPath(denylistPath))
	if err != nil {
		if errors.Is(err, secrets.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	for _, name := range names {
		if strings.TrimSuffix(name, "/") == namespace {
			return true, nil
		}
	}
	return false, nil
}

func (c *Client) rolePath(name string) string {
	base := "auth/" + c.cfg.KubernetesMount + "/role"
	if name == "" {
		return base
	}
	return base + "/" + name
}

func (c *Client) write(ctx context.Context, path string, body map[string]any) (map[string]any, error) {
	if err := c.authenticate(ctx); err != nil {
		return nil, err
	}
	resp, err := c.api.Logical().WriteWithContext(ctx, path, body)
	if err != nil {
		return nil, translate(err)
	}
	if resp == nil {
		return nil, nil
	}
	return resp.Data, nil
}

func (c *Client) read(ctx context.Context, path string) (map[string]any, error) {
	if err := c.authenticate(ctx); err != nil {
		return nil, err
	}
	resp, err := c.api.Logical().ReadWithContext(ctx, path)
	if err != nil {
		return nil, translate(err)
	}
	if resp == nil || resp.Data == nil {
		return nil, secrets.ErrNotFound
	}
	return resp.Data, nil
}

func (c *Client) delete(ctx context.Context, path string) error {
	if err := c.authenticate(ctx); err != nil {
		return err
	}
	if _, err := c.api.Logical().DeleteWithContext(ctx, path); err != nil {
		return translate(err)
	}
	return nil
}

func (c *Client) listKeys(ctx context.Context, path string) ([]string, error) {
	if err := c.authenticate(ctx); err != nil {
		return nil, err
	}
	resp, err := c.api.Logical().ListWithContext(ctx, path)
	if err != nil {
		return nil, translate(err)
	}
	if resp == nil || resp.Data == nil {
		return nil, secrets.ErrNotFound
	}
	return stringsFrom(resp.Data["keys"]), nil
}

func stringsFrom(v any) []string {
	switch vals := v.(type) {
	case []string:
		return vals
	case []any:
		out := make([]string, 0, len(vals))
		for _, item := range vals {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case string:
		if vals == "" {
			return nil
		}
		return strings.Split(vals, ",")
	}
	return nil
}
