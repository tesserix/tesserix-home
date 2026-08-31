// Package k8s reads the cluster so an administrator can pick a namespace and a
// service account that actually exist. Every call here is a list or a get: the
// ServiceAccount backing it holds no write verb, and cluster state is changed
// only through Git and ArgoCD.
package k8s

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// SecretStoreGVR is the External Secrets resource that proves a namespace is
// wired to OpenBao. The cluster serves v1alpha1 and v1beta1 only — never v1.
var SecretStoreGVR = schema.GroupVersionResource{
	Group:    "external-secrets.io",
	Version:  "v1beta1",
	Resource: "secretstores",
}

// dnsLabel is the Kubernetes name grammar. Validating before the call keeps a
// crafted namespace out of the request path entirely.
var dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

type Namespace struct {
	Name string `json:"name"`
	// HasSecretStore is the honest half of the whitelist: a grant in OpenBao
	// does nothing until External Secrets has a store here to use it.
	HasSecretStore bool `json:"hasSecretStore"`
}

type App struct {
	Name           string `json:"name"`
	Kind           string `json:"kind"`
	ServiceAccount string `json:"serviceAccount"`
	Replicas       int32  `json:"replicas"`
}

// CacheTTL bounds how stale a namespace scan may be. Rescanning on every screen
// refresh leaves the console empty for seconds at a time.
var CacheTTL = 60 * time.Second

type Discoverer struct {
	core    kubernetes.Interface
	dynamic dynamic.Interface

	mu       sync.Mutex
	cached   []Namespace
	cachedAt time.Time
}

func New(core kubernetes.Interface, dyn dynamic.Interface) *Discoverer {
	return &Discoverer{core: core, dynamic: dyn}
}

// NewInCluster builds a Discoverer from the pod's own ServiceAccount token.
func NewInCluster() (*Discoverer, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("k8s: in-cluster config: %w", err)
	}

	core, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("k8s: core client: %w", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("k8s: dynamic client: %w", err)
	}
	return New(core, dyn), nil
}

func (d *Discoverer) Namespaces(ctx context.Context) ([]Namespace, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cached != nil && time.Since(d.cachedAt) < CacheTTL {
		return d.cached, nil
	}

	list, err := d.core.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("k8s: list namespaces: %w", err)
	}
	wired, err := d.namespacesWithSecretStore(ctx)
	if err != nil {
		return nil, err
	}

	out := make([]Namespace, 0, len(list.Items))
	for _, item := range list.Items {
		out = append(out, Namespace{Name: item.Name, HasSecretStore: wired[item.Name]})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	d.cached, d.cachedAt = out, time.Now()
	return out, nil
}

func (d *Discoverer) Apps(ctx context.Context, namespace string) ([]App, error) {
	if !dnsLabel.MatchString(namespace) {
		return nil, fmt.Errorf("k8s: %q is not a valid namespace name", namespace)
	}

	deployments, err := d.core.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("k8s: list deployments in %s: %w", namespace, err)
	}
	statefulSets, err := d.core.AppsV1().StatefulSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("k8s: list statefulsets in %s: %w", namespace, err)
	}

	out := make([]App, 0, len(deployments.Items)+len(statefulSets.Items))
	for _, item := range deployments.Items {
		out = append(out, App{
			Name:           item.Name,
			Kind:           "Deployment",
			ServiceAccount: serviceAccountOf(item.Spec.Template.Spec.ServiceAccountName),
			Replicas:       replicasOf(item.Spec.Replicas),
		})
	}
	for _, item := range statefulSets.Items {
		out = append(out, App{
			Name:           item.Name,
			Kind:           "StatefulSet",
			ServiceAccount: serviceAccountOf(item.Spec.Template.Spec.ServiceAccountName),
			Replicas:       replicasOf(item.Spec.Replicas),
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// namespacesWithSecretStore treats a missing CRD as "none wired" rather than an
// error: a cluster without External Secrets installed is a valid state to report.
func (d *Discoverer) namespacesWithSecretStore(ctx context.Context) (map[string]bool, error) {
	list, err := d.dynamic.Resource(SecretStoreGVR).List(ctx, metav1.ListOptions{})
	switch {
	case errors.IsNotFound(err), meta.IsNoMatchError(err):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("k8s: list secretstores: %w", err)
	}

	wired := make(map[string]bool, len(list.Items))
	for _, item := range list.Items {
		wired[item.GetNamespace()] = true
	}
	return wired, nil
}

func serviceAccountOf(name string) string {
	if name == "" {
		return "default"
	}
	return name
}

func replicasOf(n *int32) int32 {
	if n == nil {
		return 1
	}
	return *n
}
