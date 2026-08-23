# Console Header Health Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every operator, on every console page, sees a single header indicator
reading `healthy` / `degraded` / `unmeasured`, computed by a new `platform-api`
module that reads Deployment readiness and CNPG cluster status straight from
the Kubernetes API.

**Architecture:** A new `health` module in `platform-api` follows the `tools`
module shape exactly (kernel-only imports, a `RouteTable` as the single route
declaration, a capability test that fails on an uncovered route). It reads the
Kubernetes API over plain HTTPS with `net/http` — **no `client-go`** — using the
already-mounted ServiceAccount token and CA. The result is cached ~15s in the Go
process; a failed read serves the last good value marked stale, and past ~60s it
becomes `unmeasured`. The console reads `GET /v1/platform/health` server-side in
`app/(console)/layout.tsx` — the same place it already reads the tools directory
— and threads the result into `ConsoleHeader` as a prop.

**Tech Stack:** Go 1.26.5 (stdlib only for the new code), Next.js 16 / React 19,
Vitest, Helm (`tesserix-k8s`).

**Spec:** `docs/superpowers/specs/2026-08-23-console-health-indicator-design.md`

## Global Constraints

- **No new Go dependencies.** `platform-api/go.mod` has five direct requires.
  `k8s.io/client-go` would add hundreds of modules for two GET requests. The
  Kubernetes API is REST+JSON; use `net/http` and `encoding/json`. **If you find
  yourself running `go get k8s.io/...`, stop — that is a deviation, not a
  detail.**
- **The read endpoint is gated on `auth.CapRead`, never `auth.CapPlatform`.**
  The header renders for every operator. See the spec's "It must not gate on
  `platform`" — this exact defect (C1) was found and fixed on the tools API.
- **Cross-module imports are forbidden and CI-enforced.** `internal/architecture`
  parses every file, test files included. The `health` module imports only the
  kernel (`internal/platform/...`) and its own `internal/...`.
- **Namespace-scoped RBAC only.** `Role` + `RoleBinding` in `tesserix`. Not a
  `ClusterRole`.
- **Commits:** single-line conventional commits. No signatures, no co-author
  trailers.
- **Kubernetes API paths, verbatim** (verified against `tesseract-prod-in-gke`):
  - `/apis/apps/v1/namespaces/{ns}/deployments`
  - `/apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters`
- **In-cluster ServiceAccount paths, verbatim:**
  - token: `/var/run/secrets/kubernetes.io/serviceaccount/token`
  - CA: `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`
  - namespace: `/var/run/secrets/kubernetes.io/serviceaccount/namespace`
  - API server: `https://kubernetes.default.svc`
- **The three state strings are exactly** `"healthy"`, `"degraded"`,
  `"unmeasured"`. Same spelling on both sides of the wire — no translation at
  the seam.

---

## File Structure

**`platform-api` (new module):**

| File | Responsibility |
| --- | --- |
| `internal/modules/health/health.go` | The module's entire public surface: `Register` + `Config`. Mirrors `tools/tools.go`. |
| `internal/modules/health/internal/cluster/cluster.go` | Reads the Kubernetes API. Loads token/CA, issues the two GETs, decodes only the fields used. Knows nothing about health. |
| `internal/modules/health/internal/domain/domain.go` | `Snapshot`, `State`, and `Classify` — the pure decision. No I/O, no time source of its own. |
| `internal/modules/health/internal/service/service.go` | The ~15s cache, the stale mark, and the ~60s ceiling. Owns the clock. |
| `internal/modules/health/internal/handler/handler.go` | `RouteTable`, `Routes`, the one handler, the wire shape. |

**`platform-api` (modified):** `cmd/server/main.go`, `internal/platform/config/config.go`.

**`tesserix-k8s` (separate repo):**
`charts/apps/platform-api/templates/rbac.yaml` (new),
`charts/apps/platform-api/values.yaml`,
`argocd/prod/apps/global/platform-api.yaml`.

**`apps/console`:** `lib/health.ts` (new), `components/nav/health-indicator.tsx`
(new), `components/nav/console-header.tsx`, `app/(console)/layout.tsx`.

---

### Task 1: The Kubernetes reader

Reads the cluster. Deliberately knows nothing about what "healthy" means — it
returns counts, and Task 2 decides.

**Files:**
- Create: `platform-api/internal/modules/health/internal/cluster/cluster.go`
- Test: `platform-api/internal/modules/health/internal/cluster/cluster_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Config struct { APIServer, TokenPath, CAPath, NamespacePath string; HTTPClient *http.Client }`
  - `func New(cfg Config) (*Reader, error)`
  - `func (r *Reader) Namespace() string`
  - `func (r *Reader) Deployments(ctx context.Context) ([]Workload, error)`
  - `func (r *Reader) Databases(ctx context.Context) ([]Database, error)`
  - `type Workload struct { Name string; Desired, Ready int }`
  - `type Database struct { Name string; Instances, Ready int; Phase string }`

- [ ] **Step 1: Write the failing test**

Create `cluster_test.go`. The test stands up an `httptest.TLSServer` answering
the two real paths with real-shaped payloads, and asserts the decoded counts.

Note the two field defaults being pinned: a Deployment omits `status.readyReplicas`
entirely when it is zero, and omits `spec.replicas` when it is 1. Both defaults
are asserted, because getting either wrong turns a down workload into a healthy
one — which is the exact failure this whole feature exists to prevent.

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd platform-api && go test ./internal/modules/health/...`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Write the implementation**

```go
// Package cluster reads the Kubernetes API.
//
// # Why there is no client-go here
//
// This package issues two GETs and reads six fields. client-go would add
// several hundred modules to a go.mod with five direct requires, and a
// transitive dependency surface larger than the rest of this service put
// together, in exchange for typed structs for two resources. The Kubernetes
// API is REST and JSON; net/http is a complete client for it.
//
// # It decides nothing
//
// It returns counts. Whether "2 of 3 ready" is degraded is a judgement, and
// judgements live in internal/domain where they can be tested without a
// server. A reader that classified would make the classification untestable
// without HTTP, and the classification is the part most worth testing.
package cluster

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Default in-cluster locations. Overridable in Config only so tests need not
// write to /var/run.
const (
	DefaultAPIServer     = "https://kubernetes.default.svc"
	DefaultTokenPath     = "/var/run/secrets/kubernetes.io/serviceaccount/token" //nolint:gosec // a path, not a credential
	DefaultCAPath        = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	DefaultNamespacePath = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"
)

// Config is what the reader needs. Every field has an in-cluster default.
type Config struct {
	APIServer     string
	TokenPath     string
	CAPath        string
	NamespacePath string
	// HTTPClient overrides the client built from CAPath. Tests set it; nothing
	// in production does.
	HTTPClient *http.Client
}

// Reader reads one namespace.
type Reader struct {
	apiServer string
	token     string
	namespace string
	client    *http.Client
}

// Workload is one Deployment, reduced to the question being asked of it.
type Workload struct {
	Name string
	// Desired is spec.replicas, which is ABSENT from the JSON at its default
	// of 1 — so it must default to 1, not 0. Defaulting it to 0 would make
	// every single-replica Deployment look intentionally switched off.
	Desired int
	// Ready is status.readyReplicas, ABSENT at zero. Defaulting it to
	// anything but 0 would report a down workload as up.
	Ready int
}

// Database is one CNPG Cluster.
type Database struct {
	Name      string
	Instances int
	Ready     int
	Phase     string
}

// New builds a reader, failing if the ServiceAccount token is not readable.
//
// Failing here rather than at first use is deliberate: outside a cluster there
// is no token, and the composition root needs to learn that at startup so it
// can serve `unmeasured` honestly instead of discovering it on every request.
func New(cfg Config) (*Reader, error) {
	apiServer := cfg.APIServer
	if apiServer == "" {
		apiServer = DefaultAPIServer
	}
	tokenPath := cfg.TokenPath
	if tokenPath == "" {
		tokenPath = DefaultTokenPath
	}
	namespacePath := cfg.NamespacePath
	if namespacePath == "" {
		namespacePath = DefaultNamespacePath
	}

	token, err := os.ReadFile(tokenPath)
	if err != nil {
		return nil, fmt.Errorf("reading the ServiceAccount token: %w", err)
	}
	namespace, err := os.ReadFile(namespacePath)
	if err != nil {
		return nil, fmt.Errorf("reading the ServiceAccount namespace: %w", err)
	}

	client := cfg.HTTPClient
	if client == nil {
		client, err = clientFor(cfg.CAPath)
		if err != nil {
			return nil, err
		}
	}

	return &Reader{
		apiServer: strings.TrimSuffix(apiServer, "/"),
		token:     strings.TrimSpace(string(token)),
		namespace: strings.TrimSpace(string(namespace)),
		client:    client,
	}, nil
}

func clientFor(caPath string) (*http.Client, error) {
	if caPath == "" {
		caPath = DefaultCAPath
	}
	pem, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("reading the cluster CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("the cluster CA at %s is not a PEM certificate", caPath)
	}
	return &http.Client{
		// Short. This sits behind a cache, and a slow API server must degrade
		// the indicator rather than hold a page render open.
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		},
	}, nil
}

// Namespace is the namespace this reader reads.
func (r *Reader) Namespace() string { return r.namespace }

// Deployments lists the namespace's Deployments.
func (r *Reader) Deployments(ctx context.Context) ([]Workload, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				// A POINTER, so an absent key is distinguishable from an
				// explicit 0. `replicas: 0` means switched off on purpose;
				// absent means the API server elided the default of 1. A
				// plain int would collapse those into one number and report
				// every one-replica Deployment as deliberately stopped.
				Replicas *int `json:"replicas"`
			} `json:"spec"`
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := r.get(ctx, "/apis/apps/v1/namespaces/"+r.namespace+"/deployments", &list); err != nil {
		return nil, err
	}

	workloads := make([]Workload, 0, len(list.Items))
	for _, item := range list.Items {
		desired := 1
		if item.Spec.Replicas != nil {
			desired = *item.Spec.Replicas
		}
		workloads = append(workloads, Workload{
			Name:    item.Metadata.Name,
			Desired: desired,
			Ready:   item.Status.ReadyReplicas,
		})
	}
	return workloads, nil
}

// Databases lists the namespace's CNPG Clusters.
func (r *Reader) Databases(ctx context.Context) ([]Database, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Instances      int    `json:"instances"`
				ReadyInstances int    `json:"readyInstances"`
				Phase          string `json:"phase"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := r.get(ctx, "/apis/postgresql.cnpg.io/v1/namespaces/"+r.namespace+"/clusters", &list); err != nil {
		return nil, err
	}

	databases := make([]Database, 0, len(list.Items))
	for _, item := range list.Items {
		databases = append(databases, Database{
			Name:      item.Metadata.Name,
			Instances: item.Status.Instances,
			Ready:     item.Status.ReadyInstances,
			Phase:     item.Status.Phase,
		})
	}
	return databases, nil
}

func (r *Reader) get(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.apiServer+path, nil)
	if err != nil {
		return fmt.Errorf("building the request for %s: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Accept", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("GET %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Checked BEFORE decoding. A 403 from absent RBAC has a JSON body that
	// decodes cleanly into a list with no items, and an estate reporting zero
	// workloads would classify as healthy — the parked plane, exactly.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: the API server answered %d", path, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
		return fmt.Errorf("decoding %s: %w", path, err)
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd platform-api && go test ./internal/modules/health/... -v`
Expected: PASS, four tests.

- [ ] **Step 5: Ablate the two defaults**

Change `desired := 1` to `desired := 0` and re-run.
Expected: `TestDeploymentsDecodeOmittedFieldsToTheirRealDefaults` FAILS on the
`defaulted` workload. Restore it.

Then change `Ready: item.Status.ReadyReplicas` to `Ready: item.Spec.Replicas`-ish
nonsense — simplest: `Ready: desired` — and re-run.
Expected: FAILS on `broken` and `defaulted`. Restore it.

**If either ablation passes, the test is not protecting the default and must be
fixed before moving on.**

- [ ] **Step 6: Commit**

```bash
git add platform-api/internal/modules/health/internal/cluster/
git commit -m "feat(platform-api): read deployment and CNPG status from the Kubernetes API"
```

---

### Task 2: The classification

The pure decision, with no I/O and no clock. This is the task the whole feature
exists for — `unmeasured` must be unreachable-by-accident from `healthy`.

**Files:**
- Create: `platform-api/internal/modules/health/internal/domain/domain.go`
- Test: `platform-api/internal/modules/health/internal/domain/domain_test.go`

**Interfaces:**
- Consumes: `cluster.Workload`, `cluster.Database` from Task 1.
- Produces:
  - `type State string` with `StateHealthy State = "healthy"`, `StateDegraded State = "degraded"`, `StateUnmeasured State = "unmeasured"`
  - `type Snapshot struct { State State; Reason string; Workloads Counts; Databases Counts }`
  - `type Counts struct { Total, Ready int }`
  - `func Classify(workloads []cluster.Workload, databases []cluster.Database) Snapshot`
  - `func Unmeasured(reason string) Snapshot`

- [ ] **Step 1: Write the failing test**

```go
package domain_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/domain"
)

func TestClassify(t *testing.T) {
	tests := []struct {
		name      string
		workloads []cluster.Workload
		databases []cluster.Database
		want      domain.State
	}{
		{
			name:      "everything ready is healthy",
			workloads: []cluster.Workload{{Name: "console", Desired: 2, Ready: 2}},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
			want:      domain.StateHealthy,
		},
		{
			name:      "a workload short of its desired replicas is degraded",
			workloads: []cluster.Workload{{Name: "console", Desired: 3, Ready: 1}},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
			want:      domain.StateDegraded,
		},
		{
			name:      "a database short of its instances is degraded",
			workloads: []cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
			databases: []cluster.Database{{Name: "pg", Instances: 3, Ready: 2}},
			want:      domain.StateDegraded,
		},
		{
			// A Deployment deliberately scaled to zero wants nothing and has
			// nothing. It is not broken, and reporting it as such would train
			// operators to ignore the indicator.
			name:      "a workload desiring zero replicas is not degraded",
			workloads: []cluster.Workload{{Name: "quiet", Desired: 0, Ready: 0}},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
			want:      domain.StateHealthy,
		},
		{
			// THE CENTRAL CASE. A namespace with no workloads is not a
			// healthy namespace; it is a read that returned nothing, which is
			// what a silently-broken read looks like. Reporting it healthy is
			// the parked plane rendered green, which is the failure this
			// entire feature was written to prevent.
			name:      "no workloads at all is unmeasured, never healthy",
			workloads: nil,
			databases: nil,
			want:      domain.StateUnmeasured,
		},
		{
			// Workloads present, databases absent. CNPG could be uninstalled
			// or the read could have silently returned nothing. Either way
			// nothing measured the databases, so the estate is not "healthy".
			name:      "workloads without databases is unmeasured",
			workloads: []cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
			databases: nil,
			want:      domain.StateUnmeasured,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := domain.Classify(test.workloads, test.databases)
			if got.State != test.want {
				t.Errorf("Classify = %q, want %q (reason: %q)", got.State, test.want, got.Reason)
			}
		})
	}
}

func TestClassifyCountsWhatItSaw(t *testing.T) {
	got := domain.Classify(
		[]cluster.Workload{
			{Name: "a", Desired: 1, Ready: 1},
			{Name: "b", Desired: 2, Ready: 0},
			{Name: "c", Desired: 3, Ready: 3},
		},
		[]cluster.Database{
			{Name: "pg", Instances: 1, Ready: 1},
			{Name: "pg2", Instances: 2, Ready: 0},
		},
	)
	if got.Workloads.Total != 3 || got.Workloads.Ready != 2 {
		t.Errorf("workloads = %+v, want {Total:3 Ready:2}", got.Workloads)
	}
	if got.Databases.Total != 2 || got.Databases.Ready != 1 {
		t.Errorf("databases = %+v, want {Total:2 Ready:1}", got.Databases)
	}
}

func TestDegradedNamesWhatIsWrong(t *testing.T) {
	// The reason reaches an operator. "something is degraded" sends them to
	// the cluster to find out what; naming it means they already know.
	got := domain.Classify(
		[]cluster.Workload{{Name: "mp-orders", Desired: 2, Ready: 0}},
		[]cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
	)
	if !strings.Contains(got.Reason, "mp-orders") {
		t.Errorf("reason = %q, want it to name mp-orders", got.Reason)
	}
}

func TestUnmeasuredCarriesItsReason(t *testing.T) {
	got := domain.Unmeasured("the API server answered 403")
	if got.State != domain.StateUnmeasured {
		t.Errorf("State = %q, want unmeasured", got.State)
	}
	if !strings.Contains(got.Reason, "403") {
		t.Errorf("reason = %q, want the cause preserved", got.Reason)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd platform-api && go test ./internal/modules/health/internal/domain/...`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Write the implementation**

```go
// Package domain decides what a cluster reading means.
//
// Separated from the reader because this is the part worth testing hardest and
// the part that must not need a server to test. Every rule here is a judgement
// someone can disagree with; each one is therefore written down with why.
package domain

import (
	"fmt"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
)

// State is what the indicator renders.
type State string

const (
	StateHealthy    State = "healthy"
	StateDegraded   State = "degraded"
	StateUnmeasured State = "unmeasured"
)

// Counts is how much of a thing there is and how much of it is ready.
type Counts struct {
	Total int
	Ready int
}

// Snapshot is one classification.
type Snapshot struct {
	State State
	// Reason is empty when healthy, and names the specific workload or
	// database otherwise.
	Reason    string
	Workloads Counts
	Databases Counts
}

// Unmeasured is the snapshot for "nothing measured this".
func Unmeasured(reason string) Snapshot {
	return Snapshot{State: StateUnmeasured, Reason: reason}
}

// Classify turns a cluster reading into a state.
//
// # An empty reading is unmeasured, not healthy
//
// The `tesserix` namespace always contains workloads. A reading with none did
// not observe an empty estate; it failed to observe the estate. Because the
// reader already turns a non-200 into an error, the shape that reaches here
// with zero items is the more insidious one — a 200 with nothing in it, which
// is what an RBAC grant scoped to the wrong namespace produces.
//
// The same applies to databases considered separately: workloads read fine and
// databases came back empty means the CNPG half was not measured, and an
// indicator that says "healthy" while blind to every database is telling an
// operator something it does not know.
func Classify(workloads []cluster.Workload, databases []cluster.Database) Snapshot {
	snapshot := Snapshot{
		Workloads: Counts{Total: len(workloads)},
		Databases: Counts{Total: len(databases)},
	}

	var problems []string

	for _, workload := range workloads {
		// Desired 0 is switched off on purpose, and wanting nothing is
		// satisfied by having nothing.
		if workload.Ready >= workload.Desired {
			snapshot.Workloads.Ready++
			continue
		}
		problems = append(problems, fmt.Sprintf("%s %d/%d ready",
			workload.Name, workload.Ready, workload.Desired))
	}

	for _, database := range databases {
		if database.Ready >= database.Instances && database.Instances > 0 {
			snapshot.Databases.Ready++
			continue
		}
		problems = append(problems, fmt.Sprintf("%s %d/%d instances ready",
			database.Name, database.Ready, database.Instances))
	}

	if len(workloads) == 0 || len(databases) == 0 {
		snapshot.State = StateUnmeasured
		snapshot.Reason = "the cluster read returned nothing to measure"
		return snapshot
	}

	if len(problems) > 0 {
		snapshot.State = StateDegraded
		snapshot.Reason = strings.Join(problems, "; ")
		return snapshot
	}

	snapshot.State = StateHealthy
	return snapshot
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd platform-api && go test ./internal/modules/health/internal/domain/... -v`
Expected: PASS.

- [ ] **Step 5: Ablate the empty-reading rule**

Delete the `if len(workloads) == 0 || len(databases) == 0` block entirely and
re-run.
Expected: `no workloads at all is unmeasured, never healthy` and
`workloads without databases is unmeasured` both FAIL.

**This is the single most important ablation in the plan.** If deleting that
block leaves the suite green, the feature's whole reason for existing is
untested. Restore the block.

- [ ] **Step 6: Commit**

```bash
git add platform-api/internal/modules/health/internal/domain/
git commit -m "feat(platform-api): classify a cluster reading as healthy, degraded or unmeasured"
```

---

### Task 3: The cache, the stale mark, and the ceiling

**Files:**
- Create: `platform-api/internal/modules/health/internal/service/service.go`
- Test: `platform-api/internal/modules/health/internal/service/service_test.go`

**Interfaces:**
- Consumes: `domain.Snapshot`, `domain.Unmeasured`, `domain.Classify`, `cluster.Workload`, `cluster.Database`.
- Produces:
  - `type Source interface { Deployments(context.Context) ([]cluster.Workload, error); Databases(context.Context) ([]cluster.Database, error) }`
  - `type Result struct { Snapshot domain.Snapshot; Stale bool; CheckedAt time.Time }`
  - `type Service struct { ... }`
  - `func New(source Source, now func() time.Time) *Service` — `now` nil means `time.Now`
  - `func (s *Service) Health(ctx context.Context) Result`
  - `const FreshFor = 15 * time.Second`, `const StaleCeiling = 60 * time.Second`

Note `Source` is an interface, not `*cluster.Reader`: the ceiling and staleness
rules are the point of this package and must be testable by making a read fail
on demand, which a concrete reader cannot do.

- [ ] **Step 1: Write the failing test**

```go
package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/service"
)

// stub is a Source whose answers a test controls, including failing.
type stub struct {
	workloads []cluster.Workload
	databases []cluster.Database
	err       error
	calls     int
}

func (s *stub) Deployments(context.Context) ([]cluster.Workload, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return s.workloads, nil
}

func (s *stub) Databases(context.Context) ([]cluster.Database, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.databases, nil
}

func healthy() *stub {
	return &stub{
		workloads: []cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
		databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
	}
}

// clock is a hand-wound time source. Real time cannot be used: the whole
// point of these tests is what happens 61 seconds after a failure.
type clock struct{ t time.Time }

func (c *clock) now() time.Time  { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

func newClock() *clock {
	return &clock{t: time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)}
}

func TestASecondCallInsideTheWindowDoesNotReadTheCluster(t *testing.T) {
	source, c := healthy(), newClock()
	svc := service.New(source, c.now)

	svc.Health(t.Context())
	c.add(5 * time.Second)
	svc.Health(t.Context())

	if source.calls != 1 {
		t.Errorf("read the cluster %d times, want 1 — the header renders on every page", source.calls)
	}
}

func TestTheWindowExpires(t *testing.T) {
	source, c := healthy(), newClock()
	svc := service.New(source, c.now)

	svc.Health(t.Context())
	c.add(service.FreshFor + time.Second)
	svc.Health(t.Context())

	if source.calls != 2 {
		t.Errorf("read the cluster %d times, want 2 after the window expired", source.calls)
	}
}

func TestAFailedReadServesTheLastGoodValueMarkedStale(t *testing.T) {
	source, c := healthy(), newClock()
	svc := service.New(source, c.now)

	first := svc.Health(t.Context())
	if first.Stale {
		t.Fatal("a fresh read is not stale")
	}

	source.err = errors.New("the API server answered 503")
	c.add(service.FreshFor + time.Second)

	got := svc.Health(t.Context())
	if got.Snapshot.State != domain.StateHealthy {
		t.Errorf("state = %q, want the last good value preserved", got.Snapshot.State)
	}
	if !got.Stale {
		t.Error("a value served from cache after a failed read must be marked stale")
	}
}

func TestPastTheCeilingTheStaleValueIsAbandoned(t *testing.T) {
	source, c := healthy(), newClock()
	svc := service.New(source, c.now)

	svc.Health(t.Context())
	source.err = errors.New("the API server answered 503")
	c.add(service.StaleCeiling + time.Second)

	got := svc.Health(t.Context())
	if got.Snapshot.State != domain.StateUnmeasured {
		t.Errorf("state = %q, want unmeasured — a stale green served forever is the same lie, slower",
			got.Snapshot.State)
	}
}

func TestAFailedFirstReadIsUnmeasuredNotHealthy(t *testing.T) {
	source, c := healthy(), newClock()
	source.err = errors.New("no route to host")
	svc := service.New(source, c.now)

	got := svc.Health(t.Context())
	if got.Snapshot.State != domain.StateUnmeasured {
		t.Errorf("state = %q, want unmeasured with no cached value to fall back to", got.Snapshot.State)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd platform-api && go test ./internal/modules/health/internal/service/...`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Write the implementation**

```go
// Package service caches the cluster reading.
//
// # Why a cache exists at all
//
// The indicator is in the console header, which renders on every page for
// every operator. Without a cache, every navigation puts two Kubernetes API
// calls in the critical path of a server render.
//
// # Why the cache has a ceiling
//
// Because a cache that serves the last good value forever turns one failed
// read into a permanent green light. That is the same lie as rendering a
// parked plane as healthy, just in slower motion — so staleness is both
// MARKED (the operator can see it) and BOUNDED (past the ceiling the value is
// abandoned for `unmeasured`).
package service

import (
	"context"
	"sync"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/domain"
)

const (
	// FreshFor is how long a reading is served without re-reading.
	FreshFor = 15 * time.Second
	// StaleCeiling is how long a reading may be served AFTER it stopped
	// being refreshable. Past this the service reports unmeasured.
	StaleCeiling = 60 * time.Second
)

// Source is the cluster, narrowed to what this package uses. An interface
// rather than *cluster.Reader so a test can make a read fail on demand —
// which is the only way to test the ceiling, the feature's real safety rule.
type Source interface {
	Deployments(context.Context) ([]cluster.Workload, error)
	Databases(context.Context) ([]cluster.Database, error)
}

// Result is a snapshot plus how much to trust it.
type Result struct {
	Snapshot domain.Snapshot
	// Stale means this was served from cache because a refresh failed.
	Stale bool
	// CheckedAt is when the underlying reading was taken — NOT when it was
	// served. A stale result keeps its original timestamp, which is what
	// makes the staleness legible rather than merely declared.
	CheckedAt time.Time
}

// Service caches one reading.
type Service struct {
	source Source
	now    func() time.Time

	mu       sync.Mutex
	cached   domain.Snapshot
	cachedAt time.Time
	hasValue bool
}

// New builds the service. A nil clock means time.Now.
func New(source Source, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}
	return &Service{source: source, now: now}
}

// Health returns the current reading, reading the cluster if the cached one
// has expired.
//
// Never returns an error. Every failure it can have is already a state the
// caller must render — that is what `unmeasured` IS — and returning an error
// alongside would give the handler two ways to say the same thing and an
// opportunity to render one of them as a 500.
func (s *Service) Health(ctx context.Context) Result {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if s.hasValue && now.Sub(s.cachedAt) < FreshFor {
		return Result{Snapshot: s.cached, CheckedAt: s.cachedAt}
	}

	workloads, err := s.source.Deployments(ctx)
	if err == nil {
		var databases []cluster.Database
		databases, err = s.source.Databases(ctx)
		if err == nil {
			s.cached = domain.Classify(workloads, databases)
			s.cachedAt = now
			s.hasValue = true
			return Result{Snapshot: s.cached, CheckedAt: now}
		}
	}

	// The read failed. Serve the last good value if there is one and it is
	// inside the ceiling; otherwise say so.
	if s.hasValue && now.Sub(s.cachedAt) < StaleCeiling {
		return Result{Snapshot: s.cached, Stale: true, CheckedAt: s.cachedAt}
	}

	s.hasValue = false
	return Result{
		Snapshot:  domain.Unmeasured("the cluster could not be read: " + err.Error()),
		CheckedAt: now,
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd platform-api && go test ./internal/modules/health/internal/service/... -v`
Expected: PASS, five tests.

- [ ] **Step 5: Ablate the ceiling**

Change `now.Sub(s.cachedAt) < StaleCeiling` to `true` and re-run.
Expected: `TestPastTheCeilingTheStaleValueIsAbandoned` FAILS.

Then restore it and instead delete `Stale: true` from that same return.
Expected: `TestAFailedReadServesTheLastGoodValueMarkedStale` FAILS.

Restore both. **If either passes, the safety rule is decoration.**

- [ ] **Step 6: Commit**

```bash
git add platform-api/internal/modules/health/internal/service/
git commit -m "feat(platform-api): cache the cluster reading with a bounded stale window"
```

---

### Task 4: The handler, the route table, and the capability gate

**Files:**
- Create: `platform-api/internal/modules/health/internal/handler/handler.go`
- Create: `platform-api/internal/modules/health/health.go`
- Test: `platform-api/internal/modules/health/internal/handler/handler_test.go`
- Test: `platform-api/internal/modules/health/internal/handler/capability_test.go`

**Interfaces:**
- Consumes: `service.Service`, `service.Result`, `domain.State`, `auth.Verifier`, `auth.CapRead`, `httpx.*`.
- Produces:
  - `handler.Route` (`Method`, `Pattern` — no `Write` field; this module has no writes)
  - `var handler.RouteTable []Route`
  - `func handler.New(svc *service.Service, log *slog.Logger) *Handler`
  - `func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier)`
  - `health.Register(mux, health.Config{Source, Verifier, Log})`
  - `type health.Config struct { Source service.Source; Verifier *auth.Verifier; Log *slog.Logger }`

**Wire shape** (inside the standard envelope's `data`):

```json
{
  "state": "healthy",
  "stale": false,
  "checked_at": "2026-08-23T12:00:00Z",
  "reason": null,
  "workloads": { "total": 8, "ready": 8 },
  "databases": { "total": 1, "ready": 1 }
}
```

- [ ] **Step 1: Write the failing tests**

`handler_test.go` — modelled on `modules/audit/internal/handler/handler_test.go`,
which is the right template because that module also has no database.

```go
package handler_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

type api struct {
	handler http.Handler
	t       *testing.T
}

type stubSource struct {
	workloads []cluster.Workload
	databases []cluster.Database
	err       error
}

func (s stubSource) Deployments(_ context.Context) ([]cluster.Workload, error) {
	return s.workloads, s.err
}

func (s stubSource) Databases(_ context.Context) ([]cluster.Database, error) {
	return s.databases, s.err
}

func serveAs(t *testing.T, source stubSource, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	// Through RegisterModule and the module's own Register, because that is
	// where the "no verifier, no module" guard lives. This composes what
	// cmd/server composes, line for line.
	httpx.RegisterModule(mux, verifier, "health", func(m *http.ServeMux) {
		health.Register(m, health.Config{Source: source, Verifier: verifier, Log: log})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t}
}

func (a *api) get(path string) response {
	a.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("GET %s: response is not JSON: %v (%s)", path, err, out.raw)
	}
	return out
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (r response) data(t *testing.T) map[string]any {
	t.Helper()
	if r.body["success"] != true {
		t.Fatalf("not a success: %s", r.raw)
	}
	data, ok := r.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %s", r.raw)
	}
	return data
}

var okSource = stubSource{
	workloads: []cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
	databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
}

func TestHealthAnswersTheStateAndItsCounts(t *testing.T) {
	a := serveAs(t, okSource, "read")

	got := a.get("/v1/platform/health")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data := got.data(t)
	if data["state"] != "healthy" {
		t.Errorf("state = %v, want healthy", data["state"])
	}
	if data["stale"] != false {
		t.Errorf("stale = %v, want false", data["stale"])
	}
	if data["checked_at"] == nil || data["checked_at"] == "" {
		t.Error("checked_at is missing — staleness is unreadable without it")
	}
}

func TestAFailedClusterReadIsStillA200Unmeasured(t *testing.T) {
	// NOT a 500. `unmeasured` is a legitimate answer to "how is the estate",
	// and a 500 would make the console's error path — not its unmeasured
	// path — the one that renders, which is a different and less honest UI.
	a := serveAs(t, stubSource{err: errors.New("no route to host")}, "read")

	got := a.get("/v1/platform/health")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 — unmeasured is an answer, not a failure: %s",
			got.status, got.raw)
	}
	if state := got.data(t)["state"]; state != "unmeasured" {
		t.Errorf("state = %v, want unmeasured", state)
	}
}

func TestHealthRefusesAnUnknownQueryParameter(t *testing.T) {
	a := serveAs(t, okSource, "read")

	got := a.get("/v1/platform/health?namespace=other")
	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 — there is no filtering to ask for", got.status)
	}
}
```

Add `capability_test.go`, following `modules/tools/internal/handler/capability_test.go`:

```go
package handler_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

type routeCase struct {
	capability auth.Capability
	want       int
}

// routeCases is one entry per route in handler.RouteTable, keyed by
// "METHOD /pattern" exactly as the table spells it. Both tests range over
// RouteTable and FAIL on an entry with no case here, so a second route cannot
// be served untested.
func routeCases() map[string]routeCase {
	return map[string]routeCase{
		// `read`, NOT `platform`. The header renders on every page for every
		// operator; gating this on `platform` gives a crm-only operator a 403
		// the indicator can only render as "unmeasured" — telling them the
		// estate is unmeasured when the truth is they are not authorised.
		// The same defect (C1) was found and fixed on the tools API.
		"GET /v1/platform/health": {capability: auth.CapRead, want: http.StatusOK},
	}
}

func caseFor(t *testing.T, route handler.Route) routeCase {
	t.Helper()
	key := route.Method + " " + route.Pattern
	c, ok := routeCases()[key]
	if !ok {
		t.Fatalf("%s is registered but has no capability case; add it to routeCases so "+
			"the route is proved to refuse a principal without its required capability AND "+
			"to answer one that holds it", key)
	}
	return c
}

func TestEveryRouteRefusesAPrincipalWithoutItsRequiredCapability(t *testing.T) {
	// A token that is entirely valid and holds `crm` — some OTHER capability,
	// not none: an empty Roles claim fails at the verifier itself (401)
	// before a capability is ever checked, which would prove nothing about
	// the gate this test exists to test.
	a := serveAs(t, okSource, "crm")
	for _, route := range handler.RouteTable {
		caseFor(t, route)
		got := a.get(route.Pattern)
		if got.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403: %s", route.Method, route.Pattern, got.status, got.raw)
		}
	}
}

func TestEveryRouteAnswersAPrincipalHoldingItsCapability(t *testing.T) {
	// The companion. A refusal test alone is satisfied by a route that does
	// not exist, because a 403 from a mistyped path looks exactly like a 403
	// from the capability gate.
	a := serveAs(t, okSource, "read")
	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.get(route.Pattern)
		if got.status != c.want {
			t.Errorf("%s %s = %d, want %d: %s",
				route.Method, route.Pattern, got.status, c.want, got.raw)
		}
	}
}
```

**Copy `stubParser`, `tokenFor`, `jwtShaped` and `projectID` verbatim from
`platform-api/internal/modules/audit/internal/handler/handler_test.go`.** They
are test-local helpers in that package, not shared, so they must be duplicated
rather than imported — the boundary rule forbids reaching across modules, test
files included.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd platform-api && go test ./internal/modules/health/...`
Expected: FAIL — `handler` and `health` packages do not exist.

- [ ] **Step 3: Write the implementation**

`internal/handler/handler.go`:

```go
// Package handler serves the health module's one route.
package handler

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// Handler serves the module.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Route is one of the module's paths.
//
// No `Write` field, unlike the tools module's Route: this module has no
// writes, and a bool that is false on every row is a field waiting to be
// misread as "not yet decided". A second gate can be added when a second
// route needs one.
type Route struct {
	Method  string
	Pattern string
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. Registration reads this table, and capability_test ranges over it
// and FAILS on an entry it has no case for.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/platform/health",
		handler: func(h *Handler) http.HandlerFunc { return h.health }},
}

// Routes mounts the table.
//
// One gate, `read`, and it is deliberately not parameterised per route: this
// surface renders in the console header on every page for every operator, and
// there is no route here that a session holding console entry should not see.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, route := range RouteTable {
		gate := auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapRead, h.log, route.handler(h)))
		mux.Handle(route.Method+" "+route.Pattern, gate)
	}
}

// The route takes no parameters, so the allowed set is empty and ANY query
// string is refused. There is no filtering to ask for, so `?namespace=x` is a
// caller expecting behaviour this endpoint does not have.
var noParameters = []string{}

type counts struct {
	Total int `json:"total"`
	Ready int `json:"ready"`
}

type body struct {
	State     string  `json:"state"`
	Stale     bool    `json:"stale"`
	CheckedAt string  `json:"checked_at"`
	Reason    *string `json:"reason"`
	Workloads counts  `json:"workloads"`
	Databases counts  `json:"databases"`
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	result := h.svc.Health(r.Context())

	// `reason` is a pointer so an absent reason serialises as null rather
	// than "". An empty string reads as "there is a reason and it is blank",
	// which is a different and less useful claim.
	var reason *string
	if result.Snapshot.Reason != "" {
		reason = &result.Snapshot.Reason
	}

	httpx.WriteData(w, r, http.StatusOK, body{
		State:     string(result.Snapshot.State),
		Stale:     result.Stale,
		CheckedAt: result.CheckedAt.UTC().Format(time.RFC3339),
		Reason:    reason,
		Workloads: counts(result.Snapshot.Workloads),
		Databases: counts(result.Snapshot.Databases),
	}, h.log)
}
```

`health.go` (the module's whole public surface):

```go
// Package health is the platform API's estate-health module.
//
// # The module's public surface is this file, and nothing else
//
// Register and Config. Everything it does lives under internal/.
//
// # What it answers
//
// One question — is the estate healthy, degraded, or not currently being
// measured — read from Deployment readiness and CNPG Cluster status in the
// Kubernetes API. The console header renders it on every page.
//
// # Why the third state exists
//
// Because a parked instrument answers "fine". lib/triage.ts already warns
// that a parked Prometheus returns 200 with available:false, and the tools
// module refuses to carry a status column rather than render a tile green
// because nothing measured it. `unmeasured` is that rule made into a value.
//
// # Why it reads the cluster rather than Prometheus
//
// Prometheus is one hop from the truth and blind exactly when it is parked,
// which is the case above. The API server answers whether or not anything is
// scraping.
//
// # It imports no other module
//
// Only the kernel — httpx, auth — and its own internals.
package health

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Source reads the cluster. An interface rather than a concrete reader so
	// the composition root can hand over a reader that failed to build —
	// see cmd/server — without this module knowing why.
	Source service.Source
	// Verifier authenticates the principal. Never nil:
	// httpx.RegisterModule refuses to register a module without one.
	Verifier *auth.Verifier
	Log      *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	handler.New(service.New(cfg.Source, nil), cfg.Log).Routes(mux, cfg.Verifier)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd platform-api && go test ./internal/modules/health/... -v`
Expected: PASS.

- [ ] **Step 5: Ablate the capability gate**

Change `auth.CapRead` to `auth.CapPlatform` in `Routes` and re-run.
Expected: `TestEveryRouteAnswersAPrincipalHoldingItsCapability` FAILS with 403.

Restore it. **This is the C1 guard — if flipping the gate leaves the suite
green, the defect can be reintroduced silently.**

- [ ] **Step 6: Verify the architecture boundary still holds**

Run: `cd platform-api && go test ./internal/architecture/...`
Expected: PASS — the health module imports no sibling module.

- [ ] **Step 7: Commit**

```bash
git add platform-api/internal/modules/health/
git commit -m "feat(platform-api): serve estate health on a read-gated route"
```

---

### Task 5: Compose it in the server

**Files:**
- Modify: `platform-api/cmd/server/main.go`
- Modify: `platform-api/internal/platform/config/config.go`

**Interfaces:**
- Consumes: `health.Register`, `health.Config`, `cluster.New`, `cluster.Config`.
- Produces: `config.Config.ClusterRead` of type `config.ClusterRead struct { Enabled bool; APIServer, TokenPath, CAPath, NamespacePath string }`.

- [ ] **Step 1: Add the config, with a test**

Add to `internal/platform/config/config.go`, following the existing `env()`
helper and `Auth` struct:

```go
// ClusterRead is how the health module reaches the Kubernetes API.
//
// Disabled by default. Every field has a working in-cluster default, so the
// flag exists for one reason: enabling this REQUIRES an RBAC grant that a
// human applies separately (tesserix-k8s, charts/apps/platform-api/templates/
// rbac.yaml). A deployment that has not had the grant applied must be able to
// run this build, and a service that silently tried to read the cluster
// without permission would report `unmeasured` to every operator with no
// indication that the cause was a missing manifest.
type ClusterRead struct {
	Enabled       bool
	APIServer     string
	TokenPath     string
	CAPath        string
	NamespacePath string
}
```

Wire it into `Config` as `ClusterRead ClusterRead` and populate it in `Load()`:

```go
	cfg.ClusterRead = ClusterRead{
		Enabled:       env("PLATFORM_API_CLUSTER_READ_ENABLED", "") == "true",
		APIServer:     env("PLATFORM_API_CLUSTER_API_SERVER", ""),
		TokenPath:     env("PLATFORM_API_CLUSTER_TOKEN_PATH", ""),
		CAPath:        env("PLATFORM_API_CLUSTER_CA_PATH", ""),
		NamespacePath: env("PLATFORM_API_CLUSTER_NAMESPACE_PATH", ""),
	}
```

Add to the existing config test file:

```go
func TestClusterReadIsOffUnlessExplicitlyEnabled(t *testing.T) {
	// Not "unset means on in production". The grant this needs is applied by
	// hand, so the default must be the state that works without it.
	t.Setenv("PLATFORM_API_CLUSTER_READ_ENABLED", "")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ClusterRead.Enabled {
		t.Error("cluster read defaulted to enabled")
	}
}
```

(If `config.Load()` requires database env vars in this test package, follow
whatever the neighbouring config tests already do to satisfy them — do not
weaken `Load`.)

- [ ] **Step 2: Run the config test**

Run: `cd platform-api && go test ./internal/platform/config/... -v`
Expected: PASS.

- [ ] **Step 3: Compose the module in `main.go`**

Add after the `tools` registration and before the federation client:

```go
	// Estate health. The reader is built here rather than inside the module
	// because building it can FAIL — no token outside a cluster, no CA, the
	// flag off — and the composition root is where that is a startup fact
	// rather than a per-request surprise.
	//
	// A failure is not fatal. `unmeasuredSource` makes the module answer
	// `unmeasured` with the real reason, which is exactly what the indicator
	// exists to render. Refusing to boot because a health check cannot read
	// the cluster would turn a degraded signal into an outage.
	var clusterSource service.Source = unmeasuredSource{reason: "cluster reads are disabled"}
	if cfg.ClusterRead.Enabled {
		reader, err := cluster.New(cluster.Config{
			APIServer:     cfg.ClusterRead.APIServer,
			TokenPath:     cfg.ClusterRead.TokenPath,
			CAPath:        cfg.ClusterRead.CAPath,
			NamespacePath: cfg.ClusterRead.NamespacePath,
		})
		if err != nil {
			log.Warn("cluster reads are enabled but the reader could not be built — "+
				"health will report unmeasured",
				slog.Any("error", err),
				slog.String("likely_cause", "the Role/RoleBinding in tesserix-k8s has not been applied"),
			)
			clusterSource = unmeasuredSource{reason: err.Error()}
		} else {
			log.Info("cluster reads enabled", slog.String("namespace", reader.Namespace()))
			clusterSource = reader
		}
	}

	httpx.RegisterModule(mux, verifier, "health", func(m *http.ServeMux) {
		health.Register(m, health.Config{Source: clusterSource, Verifier: verifier, Log: log})
	})
```

And at the bottom of `main.go`:

```go
// unmeasuredSource is the Source for "there is no cluster to read".
//
// It returns an error rather than empty slices. Empty slices would reach
// domain.Classify, which treats a reading with nothing in it as unmeasured
// anyway — but with the generic "returned nothing to measure" reason instead
// of the real one. The operator wants "cluster reads are disabled", not a
// description of an empty namespace.
type unmeasuredSource struct{ reason string }

func (u unmeasuredSource) Deployments(context.Context) ([]cluster.Workload, error) {
	return nil, errors.New(u.reason)
}

func (u unmeasuredSource) Databases(context.Context) ([]cluster.Database, error) {
	return nil, errors.New(u.reason)
}
```

Add the imports: `health`, `health/internal/cluster`, `health/internal/service`.

**Note the boundary rule does not forbid this** — `cmd/` is the one place
allowed to import every module, and `internal/architecture` scopes its check to
`internal/modules/`. But `cluster` and `service` are under the health module's
`internal/`, which Go's own visibility rule blocks from outside the module. **So
`Config.Source` must be satisfiable from `cmd/`.** Re-export the two types from
the module's public file:

```go
// In health.go — so the composition root can build a reader and a fallback
// without importing the module's internals, which Go forbids.
type (
	// Source is what the module reads. Re-exported so cmd/server can supply
	// one.
	Source = service.Source
	// Workload and Database are what a Source returns.
	Workload = cluster.Workload
	Database = cluster.Database
)

// NewClusterSource builds a Source that reads the Kubernetes API.
func NewClusterSource(cfg ClusterConfig) (Source, error) { ... }

// ClusterConfig is cluster.Config, re-exported.
type ClusterConfig = cluster.Config
```

Then `main.go` imports only `health` and refers to `health.Source`,
`health.NewClusterSource`, `health.ClusterConfig`, `health.Workload`,
`health.Database`. Adjust the snippets above accordingly.

- [ ] **Step 4: Build and run the whole Go suite**

Run: `cd platform-api && go build ./... && go vet ./... && go test ./...`
Expected: PASS.

- [ ] **Step 5: Ablate the boot-failure tolerance**

Temporarily change the `cluster.New` error branch to `return err` and run
`go test ./...` with `PLATFORM_API_CLUSTER_READ_ENABLED=true` and no token
present. Confirm the server would refuse to boot, then restore the warn-and-
continue branch. This one is a manual reasoning check, not a committed test —
note in the commit body only if something surprising turns up.

- [ ] **Step 6: Commit**

```bash
git add platform-api/cmd/server/main.go platform-api/internal/platform/config/ platform-api/internal/modules/health/health.go
git commit -m "feat(platform-api): compose the health module behind a cluster-read flag"
```

---

### Task 6: The RBAC manifest — written here, applied by a human

**Repo: `tesserix-k8s`, not `tesserix-home`.**

**Files:**
- Create: `charts/apps/platform-api/templates/rbac.yaml`
- Modify: `charts/apps/platform-api/values.yaml`
- Modify: `argocd/prod/apps/global/platform-api.yaml`

> **STOP — do not apply this to the cluster.** This task produces a manifest
> and a PR. **Mahesh applies it.** Granting cluster-read credentials in
> production is a human step; this would be the first thing in the estate to
> hold them.
>
> **And the order is the reverse of the usual one.** The grant must exist in
> the cluster BEFORE a platform-api build with
> `PLATFORM_API_CLUSTER_READ_ENABLED=true` is deployed. A module shipped first
> answers `unmeasured` for every operator, which from the UI is
> indistinguishable from the failure it is meant to report. Merge and apply
> this, confirm it, and only then flip the env var.

- [ ] **Step 1: Write the manifest**

```yaml
{{- if .Values.clusterRead.enabled -}}
# Read-only access to this namespace, for the health module.
#
# A Role, NOT a ClusterRole. Everything the module reads lives in this
# namespace, and this cluster also hosts unrelated estates — a ClusterRole
# would grant reads across all of them in exchange for nothing this needs.
# Widening a Role later is a visible, reviewable change; starting wide means
# nobody ever notices it was never narrowed.
#
# This is the first thing in the estate to hold cluster-read credentials.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ include "platform-api.fullname" . }}-cluster-read
  labels:
    {{- include "platform-api.labels" . | nindent 4 }}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["postgresql.cnpg.io"]
    resources: ["clusters"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ include "platform-api.fullname" . }}-cluster-read
  labels:
    {{- include "platform-api.labels" . | nindent 4 }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ include "platform-api.fullname" . }}-cluster-read
subjects:
  - kind: ServiceAccount
    name: {{ include "platform-api.serviceAccountName" . }}
    namespace: {{ .Release.Namespace }}
{{- end }}
```

**`pods` is deliberately absent.** The spec allowed it for distinguishing
"crash-looping" from "unschedulable", and said to drop it if the first
implementation does not use it. Task 1 reads Deployments and CNPG Clusters
only, so it is not granted. Add it in the phase that reads it.

Confirm `platform-api.fullname` and `platform-api.serviceAccountName` are the
actual helper names — read `charts/apps/platform-api/templates/_helpers.tpl`
first, and use whatever it defines.

- [ ] **Step 2: Add the values flag**

In `charts/apps/platform-api/values.yaml`:

```yaml
# Read-only access to Deployments and CNPG Clusters in this namespace, for the
# health module. Off by default: enabling it grants cluster credentials, which
# should be an explicit line in the ArgoCD Application rather than an implicit
# consequence of a chart bump.
clusterRead:
  enabled: false
```

- [ ] **Step 3: Verify the template renders both ways**

```bash
cd tesserix-k8s
helm template platform-api charts/apps/platform-api | grep -c "kind: Role"
# Expected: 0

helm template platform-api charts/apps/platform-api --set clusterRead.enabled=true \
  | grep -E "^kind: (Role|RoleBinding)"
# Expected: kind: Role / kind: RoleBinding
```

Also confirm the rendered `RoleBinding` subject name matches the rendered
`ServiceAccount` name — a binding to a non-existent SA applies cleanly and
grants nothing, which is the quietest possible way for this to fail:

```bash
helm template platform-api charts/apps/platform-api --set clusterRead.enabled=true \
  | grep -A3 "kind: ServiceAccount"
```

- [ ] **Step 4: Add the ArgoCD parameter**

In `argocd/prod/apps/global/platform-api.yaml`, under
`spec.source.helm.parameters`:

```yaml
        - name: clusterRead.enabled
          value: "true"
```

- [ ] **Step 5: Run the repo's own manifest tests**

`tesserix-k8s` has a Python test suite (`tests/test_ai_usage_ingest_manifests.py`
is one example). Run it and follow its conventions if it has a platform-api
equivalent:

```bash
cd tesserix-k8s && python3 -m pytest tests/ -q
```

- [ ] **Step 6: Commit and open the PR — do not apply**

```bash
cd tesserix-k8s
git checkout -b feat/platform-api-cluster-read-rbac
git add charts/apps/platform-api/ argocd/prod/apps/global/platform-api.yaml
git commit -m "feat(platform-api): grant namespace-scoped read on deployments and CNPG clusters"
git push -u origin feat/platform-api-cluster-read-rbac
gh pr create --fill
```

Then **stop and hand back**. The PR description must state that a human applies
it and that it must land before the platform-api env var is flipped.

- [ ] **Step 7: After a human confirms it is applied, verify the grant**

```bash
kubectl --context gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke \
  auth can-i list deployments -n tesserix \
  --as=system:serviceaccount:tesserix:platform-api
# Expected: yes   (it was `no` before this task)

kubectl --context gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke \
  auth can-i list clusters.postgresql.cnpg.io -n tesserix \
  --as=system:serviceaccount:tesserix:platform-api
# Expected: yes
```

Note: `kubectl`'s current context on this machine is an unrelated AKS cluster.
**Always pass `--context`** — a bare `kubectl` here reads a different estate
entirely and will answer confidently about the wrong one.

---

### Task 7: The console reader

**Files:**
- Create: `apps/console/lib/health.ts`
- Test: `apps/console/lib/health.test.ts`

**Interfaces:**
- Consumes: `platformApiOrigin`, `platformRequestWithMeta` from `@/lib/platform-api`.
- Produces:
  - `type HealthState = "healthy" | "degraded" | "unmeasured"`
  - `interface EstateHealth { readonly state: HealthState; readonly stale: boolean; readonly checkedAt: string | null; readonly reason: string | null; readonly workloads: { total: number; ready: number }; readonly databases: { total: number; ready: number } }`
  - `function parseHealth(json: unknown): EstateHealth`
  - `async function readEstateHealth(): Promise<EstateHealth>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseHealth } from "./health";

const wire = {
  state: "healthy",
  stale: false,
  checked_at: "2026-08-23T12:00:00Z",
  reason: null,
  workloads: { total: 8, ready: 8 },
  databases: { total: 1, ready: 1 },
};

describe("parseHealth", () => {
  it("carries the three states through unchanged", () => {
    for (const state of ["healthy", "degraded", "unmeasured"] as const) {
      expect(parseHealth({ ...wire, state }).state).toBe(state);
    }
  });

  it("carries the stale mark", () => {
    expect(parseHealth({ ...wire, stale: true }).stale).toBe(true);
  });

  it("carries a degraded reason", () => {
    const got = parseHealth({ ...wire, state: "degraded", reason: "mp-orders 0/2 ready" });
    expect(got.reason).toBe("mp-orders 0/2 ready");
  });

  it("reads an unrecognised state as unmeasured, never as healthy", () => {
    // A future state this build has not been taught, or a malformed answer.
    // Defaulting to "healthy" would be the parked plane one more time — this
    // time introduced by the parser rather than the sensor.
    expect(parseHealth({ ...wire, state: "sunny" }).state).toBe("unmeasured");
    expect(parseHealth({}).state).toBe("unmeasured");
    expect(parseHealth(null).state).toBe("unmeasured");
  });

  it("reads absent counts as zero rather than throwing", () => {
    // The indicator must render something on every page. A parser that
    // throws takes the whole console layout down with it.
    const got = parseHealth({ state: "healthy" });
    expect(got.workloads).toEqual({ total: 0, ready: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/console && npx vitest run lib/health.test.ts`
Expected: FAIL — `./health` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// `server-only`: this reads an operator's bearer token via platformRequest.
// A client component importing it must fail the build, not ship server code
// to the browser — see #299 and the same header on lib/tools-directory.ts.
import "server-only";

import { platformApiOrigin, platformRequestWithMeta } from "@/lib/platform-api";

/** The three states, spelled exactly as the Go module spells them. */
export type HealthState = "healthy" | "degraded" | "unmeasured";

const STATES: readonly string[] = ["healthy", "degraded", "unmeasured"];

export interface HealthCounts {
  readonly total: number;
  readonly ready: number;
}

export interface EstateHealth {
  readonly state: HealthState;
  readonly stale: boolean;
  readonly checkedAt: string | null;
  readonly reason: string | null;
  readonly workloads: HealthCounts;
  readonly databases: HealthCounts;
}

/**
 * The unmeasured value, used for every shape this parser cannot trust.
 *
 * Deliberately not exported as a mutable object: every caller getting the
 * same frozen value is fine, a caller mutating a shared default is not.
 */
const UNMEASURED: EstateHealth = Object.freeze({
  state: "unmeasured" as const,
  stale: false,
  checkedAt: null,
  reason: null,
  workloads: Object.freeze({ total: 0, ready: 0 }),
  databases: Object.freeze({ total: 0, ready: 0 }),
});

function counts(value: unknown): HealthCounts {
  if (typeof value !== "object" || value === null) return { total: 0, ready: 0 };
  const record = value as Record<string, unknown>;
  return {
    total: typeof record.total === "number" ? record.total : 0,
    ready: typeof record.ready === "number" ? record.ready : 0,
  };
}

/**
 * Parse the wire shape.
 *
 * # Why this never throws and never defaults to healthy
 *
 * It renders in the layout, on every page. A parser that throws takes the
 * console down; a parser that defaults to "healthy" renders a green light for
 * an answer it did not understand — the same lie the third state exists to
 * prevent, reintroduced one layer further out. Anything unrecognised is
 * unmeasured.
 */
export function parseHealth(json: unknown): EstateHealth {
  if (typeof json !== "object" || json === null) return UNMEASURED;
  const record = json as Record<string, unknown>;

  const state =
    typeof record.state === "string" && STATES.includes(record.state)
      ? (record.state as HealthState)
      : "unmeasured";

  return {
    state,
    stale: record.stale === true,
    checkedAt: typeof record.checked_at === "string" ? record.checked_at : null,
    reason: typeof record.reason === "string" ? record.reason : null,
    workloads: counts(record.workloads),
    databases: counts(record.databases),
  };
}

/**
 * Read estate health from the platform API.
 *
 * Falls back to `unmeasured` on every failure rather than surfacing an error,
 * for the same reason the tools directory falls back: this renders in the
 * layout, and an operator who cannot load ANY console page because the health
 * endpoint is down is far worse off than one shown an honest "unmeasured".
 *
 * `PLATFORM_API_ORIGIN` unset is also unmeasured, and correctly so — nothing
 * measured it, which is exactly what the state says.
 */
export async function readEstateHealth(): Promise<EstateHealth> {
  if (platformApiOrigin() === null) return UNMEASURED;
  try {
    const { data } = await platformRequestWithMeta("estate health", "/v1/platform/health");
    return parseHealth(data);
  } catch {
    return UNMEASURED;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/console && npx vitest run lib/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Ablate the unrecognised-state default**

Change the `state` ternary's fallback from `"unmeasured"` to `"healthy"` and
re-run.
Expected: `reads an unrecognised state as unmeasured, never as healthy` FAILS.
Restore it.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/health.ts apps/console/lib/health.test.ts
git commit -m "feat(console): read estate health from the platform API"
```

---

### Task 8: The indicator, and wiring it into the header

**Files:**
- Create: `apps/console/components/nav/health-indicator.tsx`
- Test: `apps/console/components/nav/health-indicator.render.test.tsx`
- Modify: `apps/console/components/nav/console-header.tsx`
- Modify: `apps/console/app/(console)/layout.tsx`
- Modify: `apps/console/components/nav/console-header.render.test.tsx`

**Interfaces:**
- Consumes: `EstateHealth`, `HealthState` from Task 7.
- Produces: `function HealthIndicator({ health }: { readonly health: EstateHealth }): React.JSX.Element`, and `ConsoleHeaderProps.health: EstateHealth` (required, no default).

- [ ] **Step 1: Write the failing render test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthIndicator } from "./health-indicator";
import type { EstateHealth } from "@/lib/health";

function health(overrides: Partial<EstateHealth> = {}): EstateHealth {
  return {
    state: "healthy",
    stale: false,
    checkedAt: "2026-08-23T12:00:00Z",
    reason: null,
    workloads: { total: 8, ready: 8 },
    databases: { total: 1, ready: 1 },
    ...overrides,
  };
}

describe("HealthIndicator", () => {
  it("names each state in text, not colour alone", () => {
    // WCAG 2.1 AA: colour cannot be the only carrier of meaning, and an
    // operator with a red/green deficiency is exactly the person who most
    // needs this to be legible.
    for (const state of ["healthy", "degraded", "unmeasured"] as const) {
      const { unmount } = render(<HealthIndicator health={health({ state })} />);
      expect(screen.getByRole("status")).toHaveTextContent(new RegExp(state, "i"));
      unmount();
    }
  });

  it("gives unmeasured a different accessible description from healthy", () => {
    // The whole feature. If these two read the same to a screen reader, the
    // indicator is lying to the operators who cannot see the colour.
    const first = render(<HealthIndicator health={health({ state: "healthy" })} />);
    const healthy = screen.getByRole("status").getAttribute("aria-label");
    // Unmounted rather than left in the document: two `status` roles on the
    // page would make the second getByRole throw on ambiguity, and Testing
    // Library's cleanup only runs between tests, not within one.
    first.unmount();

    render(<HealthIndicator health={health({ state: "unmeasured" })} />);
    const unmeasured = screen.getByRole("status").getAttribute("aria-label");

    expect(unmeasured).not.toBe(healthy);
  });

  it("says so when the reading is stale", () => {
    render(<HealthIndicator health={health({ stale: true })} />);
    expect(screen.getByRole("status")).toHaveAccessibleName(/stale|last known/i);
  });

  it("names what is degraded", () => {
    render(
      <HealthIndicator
        health={health({ state: "degraded", reason: "mp-orders 0/2 ready" })}
      />,
    );
    expect(screen.getByRole("status")).toHaveAccessibleName(/mp-orders/);
  });
});
```

Then extend `console-header.render.test.tsx` with:

```tsx
it("renders the health indicator", () => {
  // Threaded from the layout. If this stops rendering, every operator loses
  // the signal silently — nothing else on the page would look different.
  renderHeader({ health: { state: "degraded", stale: false, checkedAt: null,
    reason: null, workloads: { total: 1, ready: 0 }, databases: { total: 1, ready: 1 } } });
  expect(screen.getByRole("status")).toHaveTextContent(/degraded/i);
});
```

(Match `renderHeader`'s existing shape in that file; if it builds props inline,
add `health` to whatever helper it already uses.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/console && npx vitest run components/nav/health-indicator.render.test.tsx components/nav/console-header.render.test.tsx`
Expected: FAIL — component does not exist; `health` is not a prop.

- [ ] **Step 3: Write the component**

```tsx
"use client";

import type { EstateHealth, HealthState } from "@/lib/health";

/**
 * The estate's health, in the console header.
 *
 * # Three states, and the third is the point
 *
 * `unmeasured` is not a paler `healthy`. It is a different colour, a
 * different word and a different accessible name, because the failure this
 * indicator exists to prevent is an operator reading "nothing measured this"
 * as "everything is fine". See the head of the health module in platform-api.
 *
 * # Why colour is never alone
 *
 * WCAG 2.1 AA, and self-interest: the operator with a red/green deficiency is
 * the one who most needs a word here. Every state carries its name in text
 * and a fuller sentence in aria-label.
 */

interface Presentation {
  readonly label: string;
  readonly dot: string;
  readonly text: string;
}

// Paper/ink/moss tokens, not per-feature colours. `--signal` is the
// functional vermillion; `--muted-foreground` carries unmeasured, which must
// look like an absence rather than a fourth status colour.
const PRESENTATION: Record<HealthState, Presentation> = {
  healthy: {
    label: "Healthy",
    dot: "bg-[color:var(--moss-700)]",
    text: "text-muted-foreground",
  },
  degraded: {
    label: "Degraded",
    dot: "bg-[color:var(--signal)]",
    text: "text-foreground",
  },
  unmeasured: {
    label: "Unmeasured",
    dot: "border border-muted-foreground bg-transparent",
    text: "text-muted-foreground",
  },
};

function describe(health: EstateHealth): string {
  const parts: string[] = [];

  switch (health.state) {
    case "healthy":
      parts.push(
        `Estate healthy: ${health.workloads.ready} of ${health.workloads.total} workloads and ` +
          `${health.databases.ready} of ${health.databases.total} databases ready.`,
      );
      break;
    case "degraded":
      parts.push(`Estate degraded${health.reason ? `: ${health.reason}.` : "."}`);
      break;
    case "unmeasured":
      // Never "healthy" phrasing. This says the instrument is not reading,
      // which is a different claim from "everything is fine".
      parts.push(
        `Estate health is not being measured${health.reason ? `: ${health.reason}.` : "."}`,
      );
      break;
  }

  if (health.stale) {
    parts.push("This is the last known reading; the current one could not be taken.");
  }

  return parts.join(" ");
}

export function HealthIndicator({
  health,
}: {
  readonly health: EstateHealth;
}): React.JSX.Element {
  const presentation = PRESENTATION[health.state];

  return (
    <span
      // `status` rather than `alert`: this is ambient, and an alert would
      // interrupt a screen reader on every navigation.
      role="status"
      aria-label={describe(health)}
      title={describe(health)}
      className={`flex items-center gap-1.5 text-xs ${presentation.text}`}
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${presentation.dot}`} />
      <span className="hidden sm:inline">{presentation.label}</span>
      {health.stale ? <span className="hidden sm:inline">(stale)</span> : null}
    </span>
  );
}
```

- [ ] **Step 4: Wire it into the header**

In `console-header.tsx`, add to `ConsoleHeaderProps`:

```tsx
  /**
   * Fetched server-side in app/(console)/layout.tsx, like `tools`.
   * Deliberately no default: an "everything is fine" default would be the
   * exact lie the third state exists to prevent, introduced by a forgotten
   * prop rather than by a broken sensor.
   */
  readonly health: EstateHealth;
```

and render it first in the right-hand group, before the palette:

```tsx
      <div className="flex items-center gap-2">
        <HealthIndicator health={health} />
        <ConsoleCommandPalette
```

- [ ] **Step 5: Wire it into the layout**

In `app/(console)/layout.tsx`:

```tsx
import { readEstateHealth } from "@/lib/health";
```

```tsx
  // Read alongside the directory rather than after it: both are independent
  // server reads and awaiting them in sequence adds one round trip to every
  // console page render.
  const [directory, health] = await Promise.all([
    readToolsDirectory(),
    readEstateHealth(),
  ]);
```

and pass `health={health}` to `ConsoleHeader`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/console && npx vitest run components/nav/`
Expected: PASS.

- [ ] **Step 7: Ablate the unmeasured description**

Change `unmeasured`'s branch in `describe()` to reuse the `healthy` sentence
and re-run.
Expected: `gives unmeasured a different accessible description from healthy`
FAILS. Restore it.

- [ ] **Step 8: Commit**

```bash
git add apps/console/components/nav/health-indicator.tsx \
        apps/console/components/nav/health-indicator.render.test.tsx \
        apps/console/components/nav/console-header.tsx \
        apps/console/components/nav/console-header.render.test.tsx \
        "apps/console/app/(console)/layout.tsx"
git commit -m "feat(console): show estate health in the console header"
```

---

### Task 9: Full verification

`tsc` is not a build and a build is not a typecheck. Three separate CI failures
in one session came from local verification not covering what CI runs. **All
five commands, both workspaces.**

- [ ] **Step 1: Rebuild `console-core` if it was touched**

`packages/console-core` ships via a gitignored `dist/`. If any task in this plan
changed its `src/`, the console type-checks against stale types until:

```bash
cd packages/console-core && npm run build
```

(This plan does not change `console-core` — but check `git diff --stat` and run
it if something did.)

- [ ] **Step 2: Go**

```bash
cd platform-api
go build ./... && go vet ./... && go test ./... -race
```
Expected: PASS, zero skips in `./internal/modules/health/...`.

- [ ] **Step 3: Console typecheck — BOTH workspaces**

```bash
cd apps/console && npm run typecheck
cd ../../packages/console-core && npm run typecheck
```
Expected: PASS both.

- [ ] **Step 4: Unit tests, and confirm zero skips**

```bash
cd apps/console && npm run test:unit
```
Expected: PASS. **Read the summary line for skipped tests.** Database-backed
tests skip silently without `TESSERIX_TEST_DB_HOST`; a pass that skipped is not
a pass. If any health test skipped, set the variable and re-run.

- [ ] **Step 5: Lint and build**

```bash
cd apps/console && npm run lint && npm run build
```
Expected: PASS. `next build` is the only thing that catches a `server-only`
module reaching the browser bundle — which `lib/health.ts` would do if any
client component imported it directly instead of receiving `EstateHealth` as a
prop.

- [ ] **Step 6: Confirm the whole ablation set was actually run**

Walk back through the plan and confirm each ablation was performed and each
one failed the suite:

| Task | Ablation | Must fail |
| --- | --- | --- |
| 1 | `desired := 1` → `0` | omitted-defaults test |
| 1 | `Ready` sourced from desired | omitted-defaults test |
| 2 | delete the empty-reading block | both unmeasured tests |
| 3 | ceiling condition → `true` | ceiling test |
| 3 | drop `Stale: true` | stale-mark test |
| 4 | `CapRead` → `CapPlatform` | companion capability test |
| 7 | parser fallback → `"healthy"` | unrecognised-state test |
| 8 | unmeasured reuses healthy phrasing | accessible-description test |

**An ablation that leaves the suite green is a finding, not a formality.** Six
tests on the last branch passed for a reason other than the one they named, and
every one was found exactly this way.

- [ ] **Step 7: Open the PR**

```bash
git push -u origin feat/console-health-indicator
gh pr create --fill
```

The PR description must state:
1. `tesserix-k8s` PR (Task 6) **must be merged and applied first**.
2. `PLATFORM_API_CLUSTER_READ_ENABLED=true` is flipped **after** the grant is
   confirmed with `kubectl auth can-i`, not in the same change.
3. Until both are done, the indicator reads `unmeasured` — which is correct,
   and is the reason the third state exists.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| D1 one indicator, rail unchanged | 8 (no `nav.ts` change in this plan) |
| D2 three states, unmeasured distinct | 2, 7, 8 |
| D3 Go module, no `apps/web` | 1–5 |
| D4 read the cluster, not Prometheus | 1 |
| D5 ~15s cache, stale marked, ~60s ceiling | 3 |
| RBAC: Role not ClusterRole, values flag, human applies, ordering | 6 |
| Must not gate on `platform` | 4 (capability test + ablation) |
| Must not audit | n/a — no writes exist; nothing writes an audit row |
| Must not invent a second error classifier | 7 — `readEstateHealth` returns `unmeasured` rather than throwing, so no classifier is reached |
| `triage.ts` read first | Deferred: `triageState()` is the same three-valued idea but typed against `SurfaceState`, which is a *surface* vocabulary (`instrumentation-unavailable`) rather than an estate one. Task 7 defines `HealthState` with the Go module's own spelling instead, per the Global Constraint against translating at the seam. **Flagged for the reviewer** — if you would rather reuse `triageState`, that is a Task 7 change and nothing downstream depends on the choice. |
| Verification / ablations | 9, and per-task |

**Placeholder scan:** none — every code step carries real code; the one
"follow what the neighbouring test does" instruction (Task 5 Step 1, config env
setup) is bounded and names the file.

**Type consistency:** `Source`, `Workload`, `Database` are defined in Task 1,
re-exported from `health.go` in Task 5, and used by that name in Tasks 3, 4 and
5. `EstateHealth`/`HealthState` defined in Task 7, consumed in Task 8. State
strings `healthy`/`degraded`/`unmeasured` are identical in Go (Task 2), on the
wire (Task 4) and in TypeScript (Task 7).

**One known gap, deliberately left:** Task 5's re-export block is written as a
sketch (`NewClusterSource(cfg ClusterConfig) (Source, error) { ... }`) because
its body is three lines of delegation to `cluster.New` and the exact shape
depends on whether the implementer prefers type aliases or wrappers. Everything
it must satisfy is stated. If you want it fully written before starting, say so
and I will expand it.
