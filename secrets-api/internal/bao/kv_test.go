package bao_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/bao"
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

type recordedRequest struct {
	Method string
	Path   string
	Query  string
	Body   map[string]any
}

// stubBao stands in for OpenBao's HTTP API, keyed by request path. The verb is
// recorded rather than routed on: the client library picks it (GET+list=true
// for LIST, PUT for writes) and that choice is not this package's behaviour.
func stubBao(t *testing.T, routes map[string]any) (*bao.Client, *[]recordedRequest) {
	t.Helper()
	var seen []recordedRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := recordedRequest{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery}
		_ = json.NewDecoder(r.Body).Decode(&rec.Body)
		seen = append(seen, rec)

		body, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"errors":["no route"]}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)

	c, err := bao.New(bao.Config{Address: srv.URL, Mount: "kv", Token: "test-token"})
	if err != nil {
		t.Fatalf("bao.New: %v", err)
	}
	return c, &seen
}

func TestListReturnsFoldersAndLeaves(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		"/v1/kv/metadata/homechef": map[string]any{
			"data": map[string]any{"keys": []string{"api/", "db", "worker/"}},
		},
	})

	entries, err := c.List(context.Background(), "homechef")
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	want := []secrets.Entry{
		{Name: "api", IsFolder: true},
		{Name: "db", IsFolder: false},
		{Name: "worker", IsFolder: true},
	}
	if len(entries) != len(want) {
		t.Fatalf("List returned %d entries, want %d: %+v", len(entries), len(want), entries)
	}
	for i := range want {
		if entries[i] != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, entries[i], want[i])
		}
	}
	if got := (*seen)[0].Path; got != "/v1/kv/metadata/homechef" {
		t.Fatalf("listed %q, want the KV v2 metadata path", got)
	}
}

// The console opens on the root of the store, so an empty prefix is a listing
// of the top-level namespaces, not a malformed path.
func TestListOnRootReturnsTopLevelNamespaces(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		"/v1/kv/metadata": map[string]any{
			"data": map[string]any{"keys": []string{"homechef/", "marketplace/"}},
		},
	})

	entries, err := c.List(context.Background(), "/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	want := []secrets.Entry{
		{Name: "homechef", IsFolder: true},
		{Name: "marketplace", IsFolder: true},
	}
	if len(entries) != len(want) {
		t.Fatalf("List returned %d entries, want %d: %+v", len(entries), len(want), entries)
	}
	for i := range want {
		if entries[i] != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, entries[i], want[i])
		}
	}
	if got := (*seen)[0].Path; got != "/v1/kv/metadata" {
		t.Fatalf("listed %q, want the mount's metadata root", got)
	}
}

func TestListOnMissingPrefixReturnsNotFound(t *testing.T) {
	c, _ := stubBao(t, nil)

	if _, err := c.List(context.Background(), "nope"); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatalf("List error = %v, want ErrNotFound", err)
	}
}

// The console must never be able to read a secret value. There is deliberately
// no Read method, and the OpenBao policy withholds `read` on kv/data/* so a
// compromised console still cannot obtain one.
func TestClientExposesNoWayToReadAValue(t *testing.T) {
	var c any = &bao.Client{}

	if _, forbidden := c.(interface {
		Read(context.Context, string) (secrets.Secret, error)
	}); forbidden {
		t.Fatal("Client has a Read method; secret values must never leave OpenBao through this service")
	}
}

// Key names are safe to show and let an administrator overwrite a secret
// without first seeing what is in it.
func TestDescribeReturnsMetadataAndKeyNamesButNoValues(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		"/v1/kv/metadata/homechef/homechef-api/db": map[string]any{
			"data": map[string]any{
				"current_version": 7,
				"created_time":    "2026-08-01T10:00:00Z",
				"updated_time":    "2026-08-12T09:30:00Z",
				"custom_metadata": map[string]any{"keys": "password,user"},
				"versions":        map[string]any{"7": map[string]any{"created_time": "2026-08-12T09:30:00Z"}},
			},
		},
	})

	got, err := c.Describe(context.Background(), "/homechef/homechef-api/db/")
	if err != nil {
		t.Fatalf("Describe: %v", err)
	}

	if got.Version != 7 {
		t.Errorf("Version = %d, want 7", got.Version)
	}
	if len(got.Keys) != 2 || got.Keys[0] != "password" || got.Keys[1] != "user" {
		t.Errorf("Keys = %v, want [password user]", got.Keys)
	}
	if got.Ref.App != "homechef-api" {
		t.Errorf("Ref.App = %q, want homechef-api", got.Ref.App)
	}
	for _, r := range *seen {
		if strings.Contains(r.Path, "/kv/data/") {
			t.Fatalf("Describe touched %q; it must read metadata only", r.Path)
		}
	}
}

func TestDescribeRejectsTraversalBeforeCallingOpenBao(t *testing.T) {
	c, seen := stubBao(t, nil)

	if _, err := c.Describe(context.Background(), "homechef/../platform/root"); err == nil {
		t.Fatal("Describe(traversal) succeeded, want error")
	}
	if len(*seen) != 0 {
		t.Fatalf("traversal reached OpenBao: %+v", *seen)
	}
}

func TestWriteSendsDataEnvelopeAndReturnsNewVersion(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		"/v1/kv/data/homechef/homechef-api/db": map[string]any{
			"data": map[string]any{"version": 8},
		},
		"/v1/kv/metadata/homechef/homechef-api/db": map[string]any{},
	})

	version, err := c.Write(context.Background(), "homechef/homechef-api/db", map[string]string{"password": "new", "user": "app"}, 0)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if version != 8 {
		t.Fatalf("Write returned version %d, want 8", version)
	}

	body := (*seen)[0].Body
	inner, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("request body = %+v, want a KV v2 {\"data\":{...}} envelope", body)
	}
	if inner["password"] != "new" {
		t.Fatalf("request data = %+v, want the written pair", inner)
	}
}

func TestWriteRejectsEmptyPayload(t *testing.T) {
	c, seen := stubBao(t, nil)

	if _, err := c.Write(context.Background(), "homechef/homechef-api/db", map[string]string{}, 0); err == nil {
		t.Fatal("Write(empty) succeeded, want error")
	}
	if len(*seen) != 0 {
		t.Fatalf("empty write reached OpenBao: %+v", *seen)
	}
}

// A path that names no app cannot be isolated by any policy, so it is refused
// at write time rather than left unreadable in the store.
func TestWriteRejectsAPathThatNamesNoApp(t *testing.T) {
	c, seen := stubBao(t, nil)

	if _, err := c.Write(context.Background(), "homechef/db", map[string]string{"password": "new"}, 0); err == nil {
		t.Fatal("Write to a two-segment path succeeded, want error")
	}
	if len(*seen) != 0 {
		t.Fatalf("invalid write reached OpenBao: %+v", *seen)
	}
}

// The UI shows which keys a secret holds without ever reading a value, so the
// names are recorded as custom metadata on every write.
func TestWriteRecordsKeyNamesAsCustomMetadata(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		"/v1/kv/data/homechef/homechef-api/db":     map[string]any{"data": map[string]any{"version": 8}},
		"/v1/kv/metadata/homechef/homechef-api/db": map[string]any{},
	})

	if _, err := c.Write(context.Background(), "homechef/homechef-api/db", map[string]string{"user": "app", "password": "new"}, 0); err != nil {
		t.Fatalf("Write: %v", err)
	}

	var wrote bool
	for _, r := range *seen {
		if r.Path != "/v1/kv/metadata/homechef/homechef-api/db" {
			continue
		}
		wrote = true
		custom, ok := r.Body["custom_metadata"].(map[string]any)
		if !ok {
			t.Fatalf("metadata body = %+v, want custom_metadata", r.Body)
		}
		if custom["keys"] != "password,user" {
			t.Fatalf("custom_metadata.keys = %v, want the sorted key names", custom["keys"])
		}
	}
	if !wrote {
		t.Fatal("Write never recorded key names as custom metadata")
	}
}

// Two administrators editing the same secret is the ordinary case, and a blind
// write would silently throw one of them away. The version the form was drawn
// from travels with the write as KV v2's check-and-set.
func TestWriteSendsTheExpectedVersionAsCheckAndSet(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		"/v1/kv/data/homechef/homechef-api/db":     map[string]any{"data": map[string]any{"version": 8}},
		"/v1/kv/metadata/homechef/homechef-api/db": map[string]any{},
	})

	if _, err := c.Write(context.Background(), "homechef/homechef-api/db", map[string]string{"password": "new"}, 7); err != nil {
		t.Fatalf("Write: %v", err)
	}

	options, ok := (*seen)[0].Body["options"].(map[string]any)
	if !ok {
		t.Fatalf("request body = %+v, want an options block", (*seen)[0].Body)
	}
	if fmt.Sprintf("%v", options["cas"]) != "7" {
		t.Fatalf("options.cas = %v, want 7", options["cas"])
	}
}

// Zero means the caller has no expectation — creating a secret, or writing from
// a form that never saw one. Sending cas=0 would mean "only if absent" and turn
// every rewrite into a failure.
func TestWriteWithoutAnExpectedVersionSendsNoCheckAndSet(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		"/v1/kv/data/homechef/homechef-api/db":     map[string]any{"data": map[string]any{"version": 1}},
		"/v1/kv/metadata/homechef/homechef-api/db": map[string]any{},
	})

	if _, err := c.Write(context.Background(), "homechef/homechef-api/db", map[string]string{"password": "new"}, 0); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, present := (*seen)[0].Body["options"]; present {
		t.Fatalf("request body = %+v, want no options block", (*seen)[0].Body)
	}
}

func TestWriteReportsAConflictWhenTheVersionMovedOn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"errors":["check-and-set parameter did not match the current version"]}`))
	}))
	t.Cleanup(srv.Close)

	c, err := bao.New(bao.Config{Address: srv.URL, Mount: "kv", Token: "test-token"})
	if err != nil {
		t.Fatalf("bao.New: %v", err)
	}

	if _, err := c.Write(context.Background(), "homechef/homechef-api/db", map[string]string{"password": "new"}, 7); !errors.Is(err, secrets.ErrConflict) {
		t.Fatalf("Write error = %v, want ErrConflict", err)
	}
}

// A soft-deleted version is recoverable, and recovering it from the console is
// the difference between a mistake and an outage.
func TestRestoreUndeletesTheNamedVersion(t *testing.T) {
	c, seen := stubBao(t, map[string]any{"/v1/kv/undelete/homechef/api/db": map[string]any{}})

	if err := c.Restore(context.Background(), "homechef/api/db", 3); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got := (*seen)[0].Path; got != "/v1/kv/undelete/homechef/api/db" {
		t.Fatalf("Restore hit %q, want the undelete path", got)
	}
	versions, ok := (*seen)[0].Body["versions"].([]any)
	if !ok || len(versions) != 1 || fmt.Sprintf("%v", versions[0]) != "3" {
		t.Fatalf("request body = %+v, want versions [3]", (*seen)[0].Body)
	}
}

// Destroyed is destroyed: OpenBao would answer with a version that stays gone,
// so the console refuses before it asks.
func TestRestoreRejectsAVersionThatIsNotPositive(t *testing.T) {
	c, seen := stubBao(t, nil)

	if err := c.Restore(context.Background(), "homechef/api/db", 0); err == nil {
		t.Fatal("Restore(0) succeeded, want error")
	}
	if len(*seen) != 0 {
		t.Fatalf("invalid restore reached OpenBao: %+v", *seen)
	}
}

func TestDeleteSoftDeletesLatestVersion(t *testing.T) {
	c, seen := stubBao(t, map[string]any{"/v1/kv/data/homechef/api/db": map[string]any{}})

	if err := c.Delete(context.Background(), "homechef/api/db"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got := (*seen)[0].Path; got != "/v1/kv/data/homechef/api/db" {
		t.Fatalf("Delete hit %q, want the data path (soft delete)", got)
	}
}

func TestDestroyRemovesAllVersionsAndMetadata(t *testing.T) {
	c, seen := stubBao(t, map[string]any{"/v1/kv/metadata/homechef/api/db": map[string]any{}})

	if err := c.Destroy(context.Background(), "homechef/api/db"); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if got := (*seen)[0].Path; got != "/v1/kv/metadata/homechef/api/db" {
		t.Fatalf("Destroy hit %q, want the metadata path", got)
	}
}
