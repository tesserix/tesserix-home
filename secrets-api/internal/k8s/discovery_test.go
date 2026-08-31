package k8s_test

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"

	"github.com/tesserix/tesserix-home/secrets-api/internal/k8s"
)

func namespace(name string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

func deployment(ns, name, serviceAccount string, replicas int32) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{ServiceAccountName: serviceAccount},
			},
		},
	}
}

func secretStore(ns, name string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion("external-secrets.io/v1beta1")
	u.SetKind("SecretStore")
	u.SetNamespace(ns)
	u.SetName(name)
	return u
}

func clients(objects []runtime.Object, stores ...*unstructured.Unstructured) (*kubefake.Clientset, *fake.FakeDynamicClient) {
	dynamicObjects := make([]runtime.Object, 0, len(stores))
	for _, s := range stores {
		dynamicObjects = append(dynamicObjects, s)
	}

	return kubefake.NewSimpleClientset(objects...),
		fake.NewSimpleDynamicClientWithCustomListKinds(
			runtime.NewScheme(),
			map[schema.GroupVersionResource]string{k8s.SecretStoreGVR: "SecretStoreList"},
			dynamicObjects...,
		)
}

func discoverer(objects []runtime.Object, stores ...*unstructured.Unstructured) *k8s.Discoverer {
	return k8s.New(clients(objects, stores...))
}

func TestNamespacesReportsWhetherESOIsWired(t *testing.T) {
	d := discoverer(
		[]runtime.Object{namespace("homechef"), namespace("fanzone")},
		secretStore("homechef", "openbao"),
	)

	got, err := d.Namespaces(context.Background())
	if err != nil {
		t.Fatalf("Namespaces: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("Namespaces returned %d entries, want 2", len(got))
	}

	byName := map[string]k8s.Namespace{}
	for _, ns := range got {
		byName[ns.Name] = ns
	}
	if !byName["homechef"].HasSecretStore {
		t.Error("homechef.HasSecretStore = false, want true — it has a SecretStore")
	}
	if byName["fanzone"].HasSecretStore {
		t.Error("fanzone.HasSecretStore = true, want false — it has none")
	}
}

func TestNamespacesAreSortedByName(t *testing.T) {
	d := discoverer([]runtime.Object{namespace("zulu"), namespace("alpha"), namespace("mike")})

	got, err := d.Namespaces(context.Background())
	if err != nil {
		t.Fatalf("Namespaces: %v", err)
	}

	want := []string{"alpha", "mike", "zulu"}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("Namespaces[%d] = %q, want %q", i, got[i].Name, name)
		}
	}
}

// One list per namespace is 85 serial calls on this cluster, which is slow
// enough that the console times out and shows nothing.
func TestNamespacesListsSecretStoresOnceForTheWholeCluster(t *testing.T) {
	core, dyn := clients(
		[]runtime.Object{namespace("homechef"), namespace("fanzone"), namespace("marketplace")},
		secretStore("homechef", "openbao"),
	)
	d := k8s.New(core, dyn)

	got, err := d.Namespaces(context.Background())
	if err != nil {
		t.Fatalf("Namespaces: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("Namespaces returned %d entries, want 3", len(got))
	}

	if lists := len(dyn.Actions()); lists != 1 {
		t.Fatalf("Namespaces made %d secretstore calls, want 1 cluster-wide list", lists)
	}
}

func TestNamespacesAreServedFromCacheWithinTheTTL(t *testing.T) {
	core, dyn := clients([]runtime.Object{namespace("homechef")}, secretStore("homechef", "openbao"))
	d := k8s.New(core, dyn)

	if _, err := d.Namespaces(context.Background()); err != nil {
		t.Fatalf("Namespaces: %v", err)
	}
	before := len(core.Actions()) + len(dyn.Actions())

	if _, err := d.Namespaces(context.Background()); err != nil {
		t.Fatalf("Namespaces (second call): %v", err)
	}
	if after := len(core.Actions()) + len(dyn.Actions()); after != before {
		t.Fatalf("second call made %d more API calls, want the cached scan", after-before)
	}
}

func TestNamespacesRescanOnceTheCacheHasExpired(t *testing.T) {
	restore := k8s.CacheTTL
	k8s.CacheTTL = 0
	t.Cleanup(func() { k8s.CacheTTL = restore })

	core, dyn := clients([]runtime.Object{namespace("homechef")})
	d := k8s.New(core, dyn)

	if _, err := d.Namespaces(context.Background()); err != nil {
		t.Fatalf("Namespaces: %v", err)
	}
	before := len(core.Actions())

	if _, err := d.Namespaces(context.Background()); err != nil {
		t.Fatalf("Namespaces (second call): %v", err)
	}
	if len(core.Actions()) == before {
		t.Fatal("an expired cache was reused; the scan must run again")
	}
}

func TestAppsReportsWorkloadsAndTheirServiceAccounts(t *testing.T) {
	d := discoverer([]runtime.Object{
		deployment("homechef", "homechef-api", "homechef-api", 2),
		deployment("homechef", "homechef-web", "", 1),
		deployment("fanzone", "fanzone-api", "fanzone-api", 1),
	})

	got, err := d.Apps(context.Background(), "homechef")
	if err != nil {
		t.Fatalf("Apps: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("Apps returned %d entries, want the 2 in homechef", len(got))
	}

	if got[0].Name != "homechef-api" || got[0].ServiceAccount != "homechef-api" || got[0].Replicas != 2 {
		t.Errorf("Apps[0] = %+v, want homechef-api/homechef-api/2", got[0])
	}
	// An empty serviceAccountName means the pod runs as `default`; reporting it
	// blank would send an administrator to bind a service account that does not exist.
	if got[1].ServiceAccount != "default" {
		t.Errorf("Apps[1].ServiceAccount = %q, want default", got[1].ServiceAccount)
	}
}

func TestAppsIncludesStatefulSets(t *testing.T) {
	replicas := int32(3)
	sts := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "queue", Namespace: "homechef"},
		Spec: appsv1.StatefulSetSpec{
			Replicas: &replicas,
			Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{ServiceAccountName: "queue"}},
		},
	}
	d := discoverer([]runtime.Object{sts})

	got, err := d.Apps(context.Background(), "homechef")
	if err != nil {
		t.Fatalf("Apps: %v", err)
	}
	if len(got) != 1 || got[0].Kind != "StatefulSet" {
		t.Fatalf("Apps = %+v, want one StatefulSet", got)
	}
}

func TestAppsRejectsAnInvalidNamespaceName(t *testing.T) {
	d := discoverer(nil)

	if _, err := d.Apps(context.Background(), "../kube-system"); err == nil {
		t.Fatal("Apps with a traversal in the namespace succeeded, want error")
	}
}
