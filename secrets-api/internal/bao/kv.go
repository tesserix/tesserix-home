package bao

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"encoding/json"

	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

// keysMetadataField holds the comma-joined key names of the current version.
// Names only — a value never reaches metadata.
const keysMetadataField = "keys"

// List returns the immediate children of a KV prefix. An empty prefix is the
// root of the mount — the console opens there. Values are never read.
func (c *Client) List(ctx context.Context, prefix string) ([]secrets.Entry, error) {
	var clean string
	if trimmed := strings.Trim(strings.TrimSpace(prefix), "/"); trimmed != "" {
		var err error
		if clean, err = secrets.CleanSecretPath(trimmed); err != nil {
			return nil, err
		}
	}
	if err := c.authenticate(ctx); err != nil {
		return nil, err
	}

	resp, err := c.api.Logical().ListWithContext(ctx, c.metadataPath(clean))
	if err != nil {
		return nil, translate(err)
	}
	if resp == nil || resp.Data == nil {
		return nil, secrets.ErrNotFound
	}

	raw, ok := resp.Data["keys"].([]any)
	if !ok {
		return nil, secrets.ErrNotFound
	}

	entries := make([]secrets.Entry, 0, len(raw))
	for _, k := range raw {
		name, ok := k.(string)
		if !ok {
			continue
		}
		entries = append(entries, secrets.Entry{
			Name:     strings.TrimSuffix(name, "/"),
			IsFolder: strings.HasSuffix(name, "/"),
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, nil
}

// Describe reports a secret's shape — version, timestamps, and the names of the
// keys it holds — from the metadata endpoint alone. The data endpoint is never
// touched, and the token this client holds could not read it if it were.
func (c *Client) Describe(ctx context.Context, path string) (secrets.Secret, error) {
	ref, err := secrets.ParseSecretRef(path)
	if err != nil {
		return secrets.Secret{}, err
	}
	if err := c.authenticate(ctx); err != nil {
		return secrets.Secret{}, err
	}

	resp, err := c.api.Logical().ReadWithContext(ctx, c.metadataPath(ref.Path()))
	if err != nil {
		return secrets.Secret{}, translate(err)
	}
	if resp == nil || resp.Data == nil {
		return secrets.Secret{}, secrets.ErrNotFound
	}

	secret := secrets.Secret{
		Ref:       ref,
		Path:      ref.Path(),
		Version:   intFrom(resp.Data["current_version"]),
		CreatedAt: timeFrom(resp.Data["created_time"]),
		UpdatedAt: timeFrom(resp.Data["updated_time"]),
		Keys:      []string{},
	}
	if custom, ok := resp.Data["custom_metadata"].(map[string]any); ok {
		if joined, ok := custom[keysMetadataField].(string); ok && joined != "" {
			secret.Keys = strings.Split(joined, ",")
		}
	}
	return secret, nil
}

// Write replaces a secret with a new version. It is deliberately blind: the
// caller supplies the whole map because nothing here can read the old one.
//
// ifVersion is the version the caller believes is current; a positive value
// travels as KV v2's check-and-set, so a write drawn from a stale form is
// refused rather than silently overwriting someone else's.
func (c *Client) Write(ctx context.Context, path string, data map[string]string, ifVersion int) (int, error) {
	ref, err := secrets.ParseSecretRef(path)
	if err != nil {
		return 0, err
	}
	if len(data) == 0 {
		return 0, errors.New("bao: refusing to write a secret with no keys")
	}

	keys := make([]string, 0, len(data))
	payload := make(map[string]any, len(data))
	for k, v := range data {
		if strings.TrimSpace(k) == "" {
			return 0, errors.New("bao: secret keys may not be blank")
		}
		keys = append(keys, k)
		payload[k] = v
	}
	sort.Strings(keys)

	if err := c.authenticate(ctx); err != nil {
		return 0, err
	}

	body := map[string]any{"data": payload}
	if ifVersion > 0 {
		body["options"] = map[string]any{"cas": ifVersion}
	}

	resp, err := c.api.Logical().WriteWithContext(ctx, c.dataPath(ref.Path()), body)
	if err != nil {
		return 0, translate(err)
	}

	// Best effort: the secret is already written, and losing the key names
	// costs display detail rather than correctness.
	_, _ = c.api.Logical().WriteWithContext(ctx, c.metadataPath(ref.Path()), map[string]any{
		"custom_metadata": map[string]any{keysMetadataField: strings.Join(keys, ",")},
	})

	if resp == nil || resp.Data == nil {
		return 0, nil
	}
	return intFrom(resp.Data["version"]), nil
}

// Delete soft-deletes the latest version; history is retained and recoverable.
func (c *Client) Delete(ctx context.Context, path string) error {
	clean, err := secrets.CleanSecretPath(path)
	if err != nil {
		return err
	}
	if err := c.authenticate(ctx); err != nil {
		return err
	}
	if _, err := c.api.Logical().DeleteWithContext(ctx, c.dataPath(clean)); err != nil {
		return translate(err)
	}
	return nil
}

// Destroy removes every version and the metadata. This is irreversible.
func (c *Client) Destroy(ctx context.Context, path string) error {
	clean, err := secrets.CleanSecretPath(path)
	if err != nil {
		return err
	}
	if err := c.authenticate(ctx); err != nil {
		return err
	}
	if _, err := c.api.Logical().DeleteWithContext(ctx, c.metadataPath(clean)); err != nil {
		return translate(err)
	}
	return nil
}

// Restore brings a soft-deleted version back. A destroyed version is gone for
// good and OpenBao says so; this only ever reverses a delete.
func (c *Client) Restore(ctx context.Context, path string, version int) error {
	clean, err := secrets.CleanSecretPath(path)
	if err != nil {
		return err
	}
	if version <= 0 {
		return errors.New("bao: restore needs the version number to bring back")
	}
	if err := c.authenticate(ctx); err != nil {
		return err
	}

	body := map[string]any{"versions": []int{version}}
	if _, err := c.api.Logical().WriteWithContext(ctx, c.mount+"/undelete/"+clean, body); err != nil {
		return translate(err)
	}
	return nil
}

func (c *Client) Versions(ctx context.Context, path string) ([]secrets.Version, error) {
	clean, err := secrets.CleanSecretPath(path)
	if err != nil {
		return nil, err
	}
	if err := c.authenticate(ctx); err != nil {
		return nil, err
	}

	resp, err := c.api.Logical().ReadWithContext(ctx, c.metadataPath(clean))
	if err != nil {
		return nil, translate(err)
	}
	if resp == nil || resp.Data == nil {
		return nil, secrets.ErrNotFound
	}

	raw, _ := resp.Data["versions"].(map[string]any)
	versions := make([]secrets.Version, 0, len(raw))
	for num, v := range raw {
		meta, _ := v.(map[string]any)
		versions = append(versions, secrets.Version{
			Version:   intFrom(num),
			CreatedAt: timeFrom(meta["created_time"]),
			Destroyed: boolFrom(meta["destroyed"]),
			Deleted:   timeFrom(meta["deletion_time"]) != time.Time{},
		})
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].Version > versions[j].Version })
	return versions, nil
}

func (c *Client) dataPath(clean string) string { return c.mount + "/data/" + clean }

// An empty clean path addresses the mount root, which takes no trailing slash.
func (c *Client) metadataPath(clean string) string {
	return strings.TrimSuffix(c.mount+"/metadata/"+clean, "/")
}

func intFrom(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0
		}
		return int(i)
	case string:
		var i int
		if _, err := fmt.Sscanf(n, "%d", &i); err != nil {
			return 0
		}
		return i
	}
	return 0
}

func boolFrom(v any) bool {
	b, _ := v.(bool)
	return b
}

func timeFrom(v any) time.Time {
	s, ok := v.(string)
	if !ok || s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
