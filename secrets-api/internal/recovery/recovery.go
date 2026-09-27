// Package recovery launches only the approved isolated OpenBao recovery jobs.
package recovery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"golang.org/x/oauth2/google"
	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const Namespace = "openbao-recovery"

var ErrInvalid = errors.New("invalid recovery request")
var keyPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,128}$`)
var bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{2,221}[a-z0-9]$`)

// Service reads the metadata catalog and starts fixed Kubernetes templates.
type Service struct {
	cluster kubernetes.Interface
	http    *http.Client
	bucket  string
}

// Job is a metadata-only view; it never includes a pod spec or log.
type Job struct {
	Name        string     `json:"name"`
	Operation   string     `json:"operation"`
	Phase       string     `json:"phase"`
	CreatedAt   time.Time  `json:"createdAt"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
}

func NewInCluster(ctx context.Context, bucket string) (*Service, error) {
	if !bucketPattern.MatchString(bucket) {
		return nil, ErrInvalid
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("recovery cluster configuration: %w", err)
	}
	cfg.Timeout = 10 * time.Second
	cluster, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("recovery cluster client: %w", err)
	}
	client, err := google.DefaultClient(ctx, "https://www.googleapis.com/auth/devstorage.read_only")
	if err != nil {
		return nil, fmt.Errorf("recovery catalog identity: %w", err)
	}
	client.Timeout = 10 * time.Second
	return &Service{cluster: cluster, http: client, bucket: bucket}, nil
}

func (s *Service) Start(ctx context.Context, actor, operation, key string) (Job, error) {
	templateName := ""
	switch operation {
	case "backup":
		templateName = "openbao-verified-backup"
	case "restore-test":
		templateName = "openbao-restore-test"
	default:
		return Job{}, ErrInvalid
	}
	if actor == "" || len(actor) > 512 || !keyPattern.MatchString(key) {
		return Job{}, ErrInvalid
	}
	digest := sha256.Sum256([]byte(actor + "\x00" + operation + "\x00" + key))
	name := templateName + "-" + hex.EncodeToString(digest[:12])
	jobs := s.cluster.BatchV1().Jobs(Namespace)
	existing, err := jobs.Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		return summarize(existing), nil
	}
	if !apierrors.IsNotFound(err) {
		return Job{}, fmt.Errorf("get recovery operation: %w", err)
	}
	template, err := s.cluster.BatchV1().CronJobs(Namespace).Get(ctx, templateName, metav1.GetOptions{})
	if err != nil {
		return Job{}, fmt.Errorf("read recovery template: %w", err)
	}
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: Namespace, Labels: map[string]string{"app.kubernetes.io/name": "openbao-recovery", "recovery-operation": operation}}, Spec: *template.Spec.JobTemplate.Spec.DeepCopy()}
	created, err := jobs.Create(ctx, job, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		created, err = jobs.Get(ctx, name, metav1.GetOptions{})
	}
	if err != nil {
		return Job{}, fmt.Errorf("start recovery operation: %w", err)
	}
	return summarize(created), nil
}

func summarize(job *batchv1.Job) Job {
	result := Job{Name: job.Name, Operation: job.Labels["recovery-operation"], Phase: "Pending", CreatedAt: job.CreationTimestamp.Time}
	if result.Operation == "" {
		result.Operation = job.Spec.Template.Labels["recovery-operation"]
	}
	if job.Status.Active > 0 {
		result.Phase = "Running"
	}
	for _, condition := range job.Status.Conditions {
		if condition.Status != "True" {
			continue
		}
		switch condition.Type {
		case batchv1.JobComplete:
			result.Phase = "Completed"
		case batchv1.JobFailed, batchv1.JobFailureTarget:
			result.Phase = "Failed"
		}
	}
	if job.Status.CompletionTime != nil {
		value := job.Status.CompletionTime.Time
		result.CompletedAt = &value
	}
	return result
}
