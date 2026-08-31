package gcpsm_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/gcpsm"
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

type call struct {
	method string
	path   string
	query  string
	body   string
}

// fake stands in for the Secret Manager REST API: handlers are matched in
// order, and every request is recorded so a test can assert what was sent.
type fake struct {
	t       *testing.T
	calls   []call
	routes  []route
	fallbck int
}

type route struct {
	method string
	suffix string
	status int
	body   string
}

func newFake(t *testing.T, routes ...route) (*fake, *httptest.Server) {
	f := &fake{t: t, routes: routes, fallbck: http.StatusNotFound}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	f.calls = append(f.calls, call{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, body: string(raw)})

	for i, rt := range f.routes {
		if rt.method != r.Method || !strings.HasSuffix(r.URL.Path, rt.suffix) {
			continue
		}
		f.routes = append(f.routes[:i], f.routes[i+1:]...)
		w.WriteHeader(rt.status)
		_, _ = io.WriteString(w, rt.body)
		return
	}
	w.WriteHeader(f.fallbck)
	_, _ = io.WriteString(w, `{"error":{"code":404,"message":"not found"}}`)
}

func client(t *testing.T, srv *httptest.Server) *gcpsm.Client {
	t.Helper()
	c, err := gcpsm.New(gcpsm.Config{
		ProjectID:  "tesseracthub-480811",
		Endpoint:   srv.URL,
		HTTPClient: srv.Client(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func TestNewRequiresAProject(t *testing.T) {
	if _, err := gcpsm.New(gcpsm.Config{}); err == nil {
		t.Fatal("New without a project succeeded, want error")
	}
}

func TestSecretIDEncodesThePathReversibly(t *testing.T) {
	id, err := gcpsm.SecretID("homechef/homechef-api/providers/razorpay")
	if err != nil {
		t.Fatalf("SecretID: %v", err)
	}
	if id != "homechef--homechef-api--providers--razorpay" {
		t.Fatalf("SecretID = %q", id)
	}
	if got := gcpsm.PathFromSecretID(id); got != "homechef/homechef-api/providers/razorpay" {
		t.Fatalf("PathFromSecretID = %q", got)
	}
}

func TestSecretIDRejectsSegmentsGCPCannotHold(t *testing.T) {
	for _, path := range []string{
		"homechef/homechef-api/db key",     // space
		"homechef/homechef-api/db--secret", // the separator itself
		"homechef/homechef-api/db.secret",  // dot is not a legal secret id character
		"homechef/api",                     // not <namespace>/<app>/<name>
		"homechef/homechef-api/../escape",
	} {
		if id, err := gcpsm.SecretID(path); err == nil {
			t.Errorf("SecretID(%q) = %q, want error", path, id)
		}
	}
}

func TestWriteCreatesTheSecretThenAddsAVersion(t *testing.T) {
	f, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db", http.StatusNotFound, `{"error":{"code":404}}`},
		route{http.MethodPost, "/secrets", http.StatusOK, `{"name":"projects/p/secrets/homechef--api--db"}`},
		route{http.MethodPost, "/secrets/homechef--api--db:addVersion", http.StatusOK,
			`{"name":"projects/p/secrets/homechef--api--db/versions/1","state":"ENABLED"}`},
	)

	version, err := client(t, srv).Write(context.Background(), "homechef/api/db", map[string]string{"password": "hunter2", "user": "app"}, 0)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if version != 1 {
		t.Fatalf("Write returned version %d, want 1", version)
	}

	create := f.calls[1]
	if !strings.Contains(create.query, "secretId=homechef--api--db") {
		t.Fatalf("create query = %q", create.query)
	}
	var created struct {
		Labels      map[string]string `json:"labels"`
		Annotations map[string]string `json:"annotations"`
		Replication map[string]any    `json:"replication"`
	}
	if err := json.Unmarshal([]byte(create.body), &created); err != nil {
		t.Fatalf("create body: %v", err)
	}
	if created.Labels["namespace"] != "homechef" || created.Labels["app"] != "api" {
		t.Fatalf("create labels = %v", created.Labels)
	}
	if created.Labels["managed-by"] != "secret-service" {
		t.Fatalf("create is not labelled as ours: %v", created.Labels)
	}
	if created.Annotations["keys"] != "password,user" {
		t.Fatalf("annotations = %v, want sorted key names", created.Annotations)
	}
	if _, ok := created.Replication["automatic"]; !ok {
		t.Fatalf("replication = %v, want automatic", created.Replication)
	}

	var added struct {
		Payload struct {
			Data string `json:"data"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(f.calls[2].body), &added); err != nil {
		t.Fatalf("addVersion body: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(added.Payload.Data)
	if err != nil {
		t.Fatalf("payload is not base64: %v", err)
	}
	var payload map[string]string
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("payload is not a JSON object: %v", err)
	}
	if payload["password"] != "hunter2" || payload["user"] != "app" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestWriteRefusesAnEmptySecret(t *testing.T) {
	_, srv := newFake(t)
	if _, err := client(t, srv).Write(context.Background(), "homechef/api/db", nil, 0); err == nil {
		t.Fatal("Write with no keys succeeded, want error")
	}
}

func TestWriteUpdatesTheKeyNamesOnAnExistingSecret(t *testing.T) {
	f, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db", http.StatusOK,
			`{"name":"projects/p/secrets/homechef--api--db","annotations":{"keys":"password"}}`},
		route{http.MethodPatch, "/secrets/homechef--api--db", http.StatusOK, `{}`},
		route{http.MethodPost, "/secrets/homechef--api--db:addVersion", http.StatusOK,
			`{"name":"projects/p/secrets/homechef--api--db/versions/7"}`},
	)

	version, err := client(t, srv).Write(context.Background(), "homechef/api/db", map[string]string{"password": "x", "token": "y"}, 0)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if version != 7 {
		t.Fatalf("version = %d, want 7", version)
	}
	if patch := f.calls[1]; !strings.Contains(patch.query, "updateMask=annotations") || !strings.Contains(patch.body, "password,token") {
		t.Fatalf("patch = %+v", patch)
	}
}

func TestDescribeReportsShapeAndNeverAValue(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db", http.StatusOK,
			`{"name":"projects/p/secrets/homechef--api--db","createTime":"2026-08-01T10:00:00Z","annotations":{"keys":"password,user"}}`},
		route{http.MethodGet, "/secrets/homechef--api--db/versions", http.StatusOK,
			`{"versions":[{"name":"projects/p/secrets/homechef--api--db/versions/3","state":"ENABLED","createTime":"2026-08-09T09:00:00Z"},
			              {"name":"projects/p/secrets/homechef--api--db/versions/2","state":"DESTROYED","createTime":"2026-08-02T09:00:00Z"}]}`},
	)

	got, err := client(t, srv).Describe(context.Background(), "homechef/api/db")
	if err != nil {
		t.Fatalf("Describe: %v", err)
	}
	if got.Path != "homechef/api/db" || got.Ref.Namespace != "homechef" || got.Ref.App != "api" {
		t.Fatalf("Describe = %+v", got)
	}
	if got.Version != 3 {
		t.Fatalf("Version = %d, want the latest enabled version", got.Version)
	}
	if strings.Join(got.Keys, ",") != "password,user" {
		t.Fatalf("Keys = %v", got.Keys)
	}
	if got.CreatedAt.IsZero() || got.UpdatedAt.IsZero() {
		t.Fatalf("timestamps = %+v", got)
	}
}

func TestDescribeReportsNotFound(t *testing.T) {
	_, srv := newFake(t)
	if _, err := client(t, srv).Describe(context.Background(), "homechef/api/db"); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatalf("Describe = %v, want ErrNotFound", err)
	}
}

func TestListReturnsImmediateChildrenOfAPrefix(t *testing.T) {
	body := `{"secrets":[
	  {"name":"projects/p/secrets/homechef--api--db"},
	  {"name":"projects/p/secrets/homechef--api--providers--razorpay"},
	  {"name":"projects/p/secrets/homechef--web--session"},
	  {"name":"projects/p/secrets/blog--api--mongo"}
	]}`

	for _, tc := range []struct {
		prefix string
		want   []secrets.Entry
	}{
		{"/", []secrets.Entry{{Name: "blog", IsFolder: true}, {Name: "homechef", IsFolder: true}}},
		{"homechef", []secrets.Entry{{Name: "api", IsFolder: true}, {Name: "web", IsFolder: true}}},
		{"homechef/api", []secrets.Entry{{Name: "db"}, {Name: "providers", IsFolder: true}}},
		{"homechef/api/providers", []secrets.Entry{{Name: "razorpay"}}},
	} {
		_, srv := newFake(t, route{http.MethodGet, "/secrets", http.StatusOK, body})
		got, err := client(t, srv).List(context.Background(), tc.prefix)
		if err != nil {
			t.Fatalf("List(%q): %v", tc.prefix, err)
		}
		if len(got) != len(tc.want) {
			t.Fatalf("List(%q) = %+v, want %+v", tc.prefix, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("List(%q) = %+v, want %+v", tc.prefix, got, tc.want)
			}
		}
	}
}

func TestListAsksForEverySecretInTheProject(t *testing.T) {
	f, srv := newFake(t, route{http.MethodGet, "/secrets", http.StatusOK, `{"secrets":[]}`})
	if _, err := client(t, srv).List(context.Background(), "/"); err != nil {
		t.Fatalf("List: %v", err)
	}
	if strings.Contains(f.calls[0].query, "filter") {
		t.Fatalf("list query = %q, want no filter: secrets created outside the console must show too", f.calls[0].query)
	}
}

func TestListShowsSecretsNotCreatedByTheConsoleAtTheRoot(t *testing.T) {
	body := `{"secrets":[
	  {"name":"projects/p/secrets/homechef--api--db"},
	  {"name":"projects/p/secrets/analytics-db-password"}
	]}`

	_, srv := newFake(t, route{http.MethodGet, "/secrets", http.StatusOK, body})
	got, err := client(t, srv).List(context.Background(), "/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	want := []secrets.Entry{{Name: "analytics-db-password"}, {Name: "homechef", IsFolder: true}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("List = %+v, want %+v", got, want)
	}
}

func TestDescribeReadsASecretWithNoNamespaceOrApp(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets/analytics-db-password", http.StatusOK,
			`{"name":"projects/p/secrets/analytics-db-password","createTime":"2026-01-02T03:04:05Z"}`},
		route{http.MethodGet, "/secrets/analytics-db-password/versions", http.StatusOK,
			`{"versions":[{"name":"projects/p/secrets/analytics-db-password/versions/3","state":"ENABLED"}]}`},
	)

	got, err := client(t, srv).Describe(context.Background(), "analytics-db-password")
	if err != nil {
		t.Fatalf("Describe: %v", err)
	}
	if got.Path != "analytics-db-password" || got.Version != 3 {
		t.Fatalf("Describe = %+v, want path analytics-db-password at version 3", got)
	}
	if got.Ref != (secrets.SecretRef{Name: "analytics-db-password"}) {
		t.Fatalf("Describe ref = %+v, want only a name: the secret names no namespace or app", got.Ref)
	}
}

func TestDestroyRemovesASecretWithNoNamespaceOrApp(t *testing.T) {
	f, srv := newFake(t, route{http.MethodDelete, "/secrets/analytics-db-password", http.StatusOK, `{}`})
	if err := client(t, srv).Destroy(context.Background(), "analytics-db-password"); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if f.calls[0].method != http.MethodDelete {
		t.Fatalf("calls = %+v, want a DELETE", f.calls)
	}
}

func TestListPagesThroughResults(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets", http.StatusOK,
			`{"secrets":[{"name":"projects/p/secrets/homechef--api--db"}],"nextPageToken":"more"}`},
		route{http.MethodGet, "/secrets", http.StatusOK,
			`{"secrets":[{"name":"projects/p/secrets/blog--api--mongo"}]}`},
	)

	got, err := client(t, srv).List(context.Background(), "/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("List = %+v, want both pages", got)
	}
}

func TestDeleteDisablesTheLatestEnabledVersion(t *testing.T) {
	f, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db/versions", http.StatusOK,
			`{"versions":[{"name":"projects/p/secrets/homechef--api--db/versions/4","state":"ENABLED"},
			              {"name":"projects/p/secrets/homechef--api--db/versions/3","state":"ENABLED"}]}`},
		route{http.MethodPost, "/versions/4:disable", http.StatusOK, `{}`},
	)

	if err := client(t, srv).Delete(context.Background(), "homechef/api/db"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if last := f.calls[len(f.calls)-1]; !strings.HasSuffix(last.path, "/versions/4:disable") {
		t.Fatalf("last call = %+v, want version 4 disabled", last)
	}
}

func TestDeleteReportsNotFoundWhenNothingIsEnabled(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db/versions", http.StatusOK,
			`{"versions":[{"name":"projects/p/secrets/homechef--api--db/versions/1","state":"DESTROYED"}]}`},
	)
	if err := client(t, srv).Delete(context.Background(), "homechef/api/db"); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatalf("Delete = %v, want ErrNotFound", err)
	}
}

// Secret Manager has no check-and-set, so the console compares the version the
// caller was editing against the live one before adding another.
func TestWriteRefusesWhenTheExpectedVersionIsNoLongerCurrent(t *testing.T) {
	f, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db/versions", http.StatusOK,
			`{"versions":[{"name":"projects/p/secrets/homechef--api--db/versions/9","state":"ENABLED"}]}`},
	)

	_, err := client(t, srv).Write(context.Background(), "homechef/api/db", map[string]string{"password": "x"}, 7)
	if !errors.Is(err, secrets.ErrConflict) {
		t.Fatalf("Write = %v, want ErrConflict", err)
	}
	for _, c := range f.calls {
		if strings.Contains(c.path, ":addVersion") {
			t.Fatalf("a stale write reached Secret Manager: %+v", c)
		}
	}
}

func TestWriteProceedsWhenTheExpectedVersionIsStillCurrent(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db/versions", http.StatusOK,
			`{"versions":[{"name":"projects/p/secrets/homechef--api--db/versions/7","state":"ENABLED"}]}`},
		route{http.MethodGet, "/secrets/homechef--api--db", http.StatusOK,
			`{"name":"projects/p/secrets/homechef--api--db","annotations":{"keys":"password"}}`},
		route{http.MethodPatch, "/secrets/homechef--api--db", http.StatusOK, `{}`},
		route{http.MethodPost, "/secrets/homechef--api--db:addVersion", http.StatusOK,
			`{"name":"projects/p/secrets/homechef--api--db/versions/8"}`},
	)

	version, err := client(t, srv).Write(context.Background(), "homechef/api/db", map[string]string{"password": "x"}, 7)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if version != 8 {
		t.Fatalf("Write returned version %d, want 8", version)
	}
}

func TestHealthAsksSecretManagerForOneSecret(t *testing.T) {
	f, srv := newFake(t, route{http.MethodGet, "/secrets", http.StatusOK, `{"secrets":[]}`})

	if err := client(t, srv).Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
	if !strings.Contains(f.calls[0].query, "pageSize=1") {
		t.Fatalf("health call = %+v, want a single-item listing", f.calls[0])
	}
}

func TestHealthReportsAProjectItCannotRead(t *testing.T) {
	_, srv := newFake(t, route{http.MethodGet, "/secrets", http.StatusForbidden, `{"error":{"code":403}}`})

	if err := client(t, srv).Health(context.Background()); err == nil {
		t.Fatal("Health on a denied project succeeded, want error")
	}
}

// Delete disables a version, so restoring one enables it again.
func TestRestoreEnablesTheNamedVersion(t *testing.T) {
	f, srv := newFake(t, route{http.MethodPost, "/versions/3:enable", http.StatusOK, `{}`})

	if err := client(t, srv).Restore(context.Background(), "homechef/api/db", 3); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if last := f.calls[len(f.calls)-1]; !strings.HasSuffix(last.path, "/versions/3:enable") {
		t.Fatalf("last call = %+v, want version 3 enabled", last)
	}
}

func TestDestroyDeletesTheWholeSecret(t *testing.T) {
	f, srv := newFake(t, route{http.MethodDelete, "/secrets/homechef--api--db", http.StatusOK, `{}`})
	if err := client(t, srv).Destroy(context.Background(), "homechef/api/db"); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if f.calls[0].method != http.MethodDelete {
		t.Fatalf("calls = %+v", f.calls)
	}
}

func TestVersionsReportStateNewestFirst(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db/versions", http.StatusOK,
			`{"versions":[{"name":"projects/p/secrets/homechef--api--db/versions/2","state":"DISABLED","createTime":"2026-08-02T09:00:00Z"},
			              {"name":"projects/p/secrets/homechef--api--db/versions/3","state":"ENABLED","createTime":"2026-08-03T09:00:00Z"},
			              {"name":"projects/p/secrets/homechef--api--db/versions/1","state":"DESTROYED","createTime":"2026-08-01T09:00:00Z"}]}`},
	)

	got, err := client(t, srv).Versions(context.Background(), "homechef/api/db")
	if err != nil {
		t.Fatalf("Versions: %v", err)
	}
	if len(got) != 3 || got[0].Version != 3 || got[1].Version != 2 || got[2].Version != 1 {
		t.Fatalf("Versions = %+v, want newest first", got)
	}
	if got[0].Deleted || got[0].Destroyed {
		t.Fatalf("version 3 = %+v, want live", got[0])
	}
	if !got[1].Deleted || got[1].Destroyed {
		t.Fatalf("version 2 = %+v, want disabled", got[1])
	}
	if !got[2].Destroyed {
		t.Fatalf("version 1 = %+v, want destroyed", got[2])
	}
}

func TestForbiddenIsReportedAsPolicyDenial(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db", http.StatusForbidden,
			`{"error":{"code":403,"message":"caller lacks secretmanager.secrets.get"}}`},
	)
	_, err := client(t, srv).Describe(context.Background(), "homechef/api/db")
	if !errors.Is(err, secrets.ErrForbidden) {
		t.Fatalf("Describe = %v, want ErrForbidden", err)
	}
	if strings.Contains(err.Error(), "secretmanager.secrets.get") {
		t.Fatalf("error leaks the provider's message: %v", err)
	}
}

func TestUserManagedReplicationIsRequestedWhenLocationsAreSet(t *testing.T) {
	f, srv := newFake(t,
		route{http.MethodGet, "/secrets/homechef--api--db", http.StatusNotFound, `{}`},
		route{http.MethodPost, "/secrets", http.StatusOK, `{}`},
		route{http.MethodPost, ":addVersion", http.StatusOK, `{"name":"projects/p/secrets/homechef--api--db/versions/1"}`},
	)
	c, err := gcpsm.New(gcpsm.Config{
		ProjectID:  "p",
		Endpoint:   srv.URL,
		HTTPClient: srv.Client(),
		Locations:  []string{"asia-south1"},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := c.Write(context.Background(), "homechef/api/db", map[string]string{"k": "v"}, 0); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if !strings.Contains(f.calls[1].body, `"userManaged"`) || !strings.Contains(f.calls[1].body, "asia-south1") {
		t.Fatalf("create body = %s", f.calls[1].body)
	}
}

// A secret created outside this console is a flat id whose whole payload is the
// value. Rotating one is the commonest reason to open the console at all, and
// writing a JSON object over it would break every ExternalSecret reading it
// without a property.
func TestWriteReplacesTheWholePayloadOfAFlatSecret(t *testing.T) {
	f, srv := newFake(t,
		route{http.MethodGet, "/secrets/DEBUG_CF", http.StatusOK, `{"name":"projects/p/secrets/DEBUG_CF"}`},
		route{http.MethodPost, "/secrets/DEBUG_CF:addVersion", http.StatusOK,
			`{"name":"projects/p/secrets/DEBUG_CF/versions/4"}`},
	)

	version, err := client(t, srv).Write(context.Background(), "DEBUG_CF", map[string]string{"value": "rotated"}, 0)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if version != 4 {
		t.Fatalf("version = %d, want 4", version)
	}

	var added struct {
		Payload struct {
			Data string `json:"data"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(f.calls[1].body), &added); err != nil {
		t.Fatalf("addVersion body: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(added.Payload.Data)
	if err != nil {
		t.Fatalf("payload is not base64: %v", err)
	}
	if string(raw) != "rotated" {
		t.Fatalf("payload = %q, want the raw value with no JSON wrapper", raw)
	}
}

func TestWriteRefusesSeveralKeysOnAFlatSecret(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets/DEBUG_CF", http.StatusOK, `{"name":"projects/p/secrets/DEBUG_CF"}`},
	)

	_, err := client(t, srv).Write(context.Background(), "DEBUG_CF", map[string]string{"a": "1", "b": "2"}, 0)
	if err == nil {
		t.Fatal("Write of two keys into a flat secret succeeded, want error")
	}
	if !strings.Contains(err.Error(), "value") {
		t.Errorf("error = %v, want it to name the single value a flat secret holds", err)
	}
}

// Creating a secret is the console's namespaced flow. A flat id it has never
// seen is far more likely to be a typo than a deliberate new secret.
func TestWriteRefusesToCreateAFlatSecret(t *testing.T) {
	_, srv := newFake(t,
		route{http.MethodGet, "/secrets/TYPO", http.StatusNotFound, `{"error":{"code":404}}`},
	)

	if _, err := client(t, srv).Write(context.Background(), "TYPO", map[string]string{"value": "x"}, 0); err == nil {
		t.Fatal("Write created a flat secret, want it refused")
	}
}
