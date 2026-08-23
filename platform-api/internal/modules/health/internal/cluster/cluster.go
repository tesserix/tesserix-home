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
