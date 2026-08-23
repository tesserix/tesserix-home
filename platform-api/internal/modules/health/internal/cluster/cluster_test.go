package cluster_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
)

// A Deployment with NO status.readyReplicas key and NO spec.replicas key.
// Both are omitted by the API server at their zero/default values, and both
// defaults matter: readyReplicas absent means 0 (down), replicas absent
// means 1 (wanted).
const deploymentsJSON = `{"items":[
 {"metadata":{"name":"console"},"spec":{"replicas":2},"status":{"replicas":2,"readyReplicas":2}},
 {"metadata":{"name":"quiet"},"spec":{"replicas":0},"status":{"replicas":0}},
 {"metadata":{"name":"broken"},"spec":{"replicas":3},"status":{"replicas":3,"readyReplicas":1}},
 {"metadata":{"name":"defaulted"},"status":{"replicas":1}}
]}`

const clustersJSON = `{"items":[
 {"metadata":{"name":"tesserix-postgres"},"status":{"instances":1,"readyInstances":1,"phase":"Cluster in healthy state"}},
 {"metadata":{"name":"sick"},"status":{"instances":3,"readyInstances":2,"phase":"Failing over"}}
]}`

func newReader(t *testing.T, handler http.Handler) *cluster.Reader {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)

	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	namespace := filepath.Join(dir, "namespace")
	if err := os.WriteFile(token, []byte("tok-123"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(namespace, []byte("tesserix"), 0o600); err != nil {
		t.Fatal(err)
	}

	// No CAPath: the test server's own client already trusts it, which is
	// what HTTPClient is for. In production CAPath is set and HTTPClient nil.
	reader, err := cluster.New(cluster.Config{
		APIServer:     server.URL,
		TokenPath:     token,
		NamespacePath: namespace,
		HTTPClient:    server.Client(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return reader
}

func routes(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /apis/apps/v1/namespaces/tesserix/deployments",
		func(w http.ResponseWriter, r *http.Request) {
			if got := r.Header.Get("Authorization"); got != "Bearer tok-123" {
				t.Errorf("Authorization = %q, want the ServiceAccount token", got)
			}
			_, _ = w.Write([]byte(deploymentsJSON))
		})
	mux.HandleFunc("GET /apis/postgresql.cnpg.io/v1/namespaces/tesserix/clusters",
		func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(clustersJSON))
		})
	return mux
}

func TestDeploymentsDecodeOmittedFieldsToTheirRealDefaults(t *testing.T) {
	reader := newReader(t, routes(t))

	got, err := reader.Deployments(t.Context())
	if err != nil {
		t.Fatalf("Deployments: %v", err)
	}
	want := []cluster.Workload{
		{Name: "console", Desired: 2, Ready: 2},
		{Name: "quiet", Desired: 0, Ready: 0},
		{Name: "broken", Desired: 3, Ready: 1},
		// spec.replicas absent => 1, status.readyReplicas absent => 0.
		{Name: "defaulted", Desired: 1, Ready: 0},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d workloads, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("workload %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestDatabasesDecodeInstanceCountsAndPhase(t *testing.T) {
	reader := newReader(t, routes(t))

	got, err := reader.Databases(t.Context())
	if err != nil {
		t.Fatalf("Databases: %v", err)
	}
	want := []cluster.Database{
		{Name: "tesserix-postgres", Instances: 1, Ready: 1, Phase: "Cluster in healthy state"},
		{Name: "sick", Instances: 3, Ready: 2, Phase: "Failing over"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d databases, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("database %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestANonOKStatusIsAnErrorRatherThanAnEmptyList(t *testing.T) {
	// A 403 from missing RBAC decodes as `{"items":null}` if you ignore the
	// status code — which would report an estate with zero workloads as
	// perfectly healthy. That is the parked-plane failure in its most likely
	// real form, because missing RBAC is exactly what will happen if the
	// manifest in Task 6 is not applied first.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /apis/apps/v1/namespaces/tesserix/deployments",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"kind":"Status","code":403,"message":"forbidden"}`))
		})
	reader := newReader(t, mux)

	if _, err := reader.Deployments(t.Context()); err == nil {
		t.Fatal("a 403 returned no error — a forbidden read must never look like an empty cluster")
	}
}

func TestNewFailsWhenTheTokenIsAbsent(t *testing.T) {
	// Running outside a cluster. Failing here is what lets the composition
	// root decide to serve `unmeasured` rather than crash-looping.
	_, err := cluster.New(cluster.Config{
		APIServer: "https://kubernetes.default.svc",
		TokenPath: filepath.Join(t.TempDir(), "absent"),
	})
	if err == nil {
		t.Fatal("New with no token file returned no error")
	}
}
