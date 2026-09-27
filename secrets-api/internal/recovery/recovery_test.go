package recovery

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestStartUsesFixedTemplateAndDeduplicatesRetries(t *testing.T) {
	template := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "openbao-verified-backup", Namespace: Namespace}, Spec: batchv1.CronJobSpec{JobTemplate: batchv1.JobTemplateSpec{Spec: batchv1.JobSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app.kubernetes.io/name": "openbao-recovery", "recovery-operation": "backup"}, Annotations: map[string]string{"sidecar.istio.io/inject": "false"}}, Spec: corev1.PodSpec{ServiceAccountName: "openbao-backup", Containers: []corev1.Container{{Name: "recovery", Image: "pinned@sha256:abc"}}}}}}}}
	client := fake.NewClientset(template)
	service := &Service{cluster: client}
	first, err := service.Start(context.Background(), "operator", "backup", "550e8400-e29b-41d4-a716-446655440000")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Start(context.Background(), "operator", "backup", "550e8400-e29b-41d4-a716-446655440000")
	if err != nil {
		t.Fatal(err)
	}
	if first.Name != second.Name {
		t.Fatal("retry created another operation")
	}
	jobs, err := client.BatchV1().Jobs(Namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs.Items) != 1 || jobs.Items[0].Spec.Template.Spec.Containers[0].Image != "pinned@sha256:abc" || jobs.Items[0].Spec.Template.Spec.ServiceAccountName != "openbao-backup" {
		t.Fatalf("unexpected jobs: %v", jobs.Items)
	}
	if _, err = service.Start(context.Background(), "operator", "production-restore", "550e8400-e29b-41d4-a716-446655440000"); err == nil {
		t.Fatal("production restore accepted")
	}
}

func TestStatusProjectsOnlyVerifiedMetadataAndFailsClosed(t *testing.T) {
	body := `{"schema":1,"backups":[{"id":"20260927T055111Z-ae918f84b8d8","created":"2026-09-27T05:51:11Z","bytes":200000,"restore_seconds":19.884,"verified":true,"openbao_version":"2.6.2","marker_sha256":"never-return-this"}]}`
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://storage.googleapis.com/storage/v1/b/recovery-bucket/o/catalog.json?alt=media" {
			t.Fatalf("unexpected request %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	service := &Service{cluster: fake.NewClientset(), http: &http.Client{Transport: transport}, bucket: "recovery-bucket"}
	status, err := service.Status(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Backups) != 1 || status.Backups[0].RestoreSeconds != 19.884 || !status.JobsComplete {
		t.Fatalf("unexpected status %+v", status)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "never-return-this") || strings.Contains(string(encoded), "marker") {
		t.Fatal("private verification metadata escaped")
	}
	body = strings.Replace(body, `"verified":true`, `"verified":false`, 1)
	if _, err = service.Status(t.Context()); err == nil {
		t.Fatal("unverified backup accepted")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
