package recovery

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var backupIDPattern = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$`)

// Backup is the public projection of a verified recovery point.
type Backup struct {
	ID             string    `json:"id"`
	Created        time.Time `json:"created"`
	Bytes          int64     `json:"bytes"`
	RestoreSeconds float64   `json:"restoreSeconds"`
	OpenBaoVersion string    `json:"openbaoVersion"`
}

// Status contains recovery metadata, never snapshot bytes or credentials.
type Status struct {
	Backups      []Backup `json:"backups"`
	Jobs         []Job    `json:"jobs"`
	JobsComplete bool     `json:"jobsComplete"`
}

func (s *Service) Status(ctx context.Context) (Status, error) {
	result := Status{Backups: []Backup{}, Jobs: []Job{}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://storage.googleapis.com/storage/v1/b/"+s.bucket+"/o/catalog.json?alt=media", nil)
	if err != nil {
		return result, fmt.Errorf("catalog request: %w", err)
	}
	response, err := s.http.Do(req)
	if err != nil {
		return result, fmt.Errorf("read recovery catalog: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		if response.StatusCode != http.StatusOK {
			return result, fmt.Errorf("catalog unavailable: HTTP %d", response.StatusCode)
		}
		raw, err := io.ReadAll(io.LimitReader(response.Body, 1048577))
		if err != nil {
			return result, fmt.Errorf("read catalog body: %w", err)
		}
		if len(raw) > 1048576 {
			return result, fmt.Errorf("catalog exceeds size limit")
		}
		var catalog struct {
			Schema  int `json:"schema"`
			Backups []struct {
				ID             string    `json:"id"`
				Created        time.Time `json:"created"`
				Bytes          int64     `json:"bytes"`
				RestoreSeconds float64   `json:"restore_seconds"`
				Verified       bool      `json:"verified"`
				OpenBaoVersion string    `json:"openbao_version"`
			} `json:"backups"`
		}
		if err = json.Unmarshal(raw, &catalog); err != nil {
			return result, fmt.Errorf("decode recovery catalog: %w", err)
		}
		if catalog.Schema != 1 || catalog.Backups == nil || len(catalog.Backups) > 3 {
			return result, fmt.Errorf("invalid recovery catalog")
		}
		seen := map[string]bool{}
		for _, item := range catalog.Backups {
			if !backupIDPattern.MatchString(item.ID) || seen[item.ID] || !item.Verified || item.Created.IsZero() || item.Bytes < 1 || item.Bytes > 256*1024*1024 || item.RestoreSeconds < 0 || item.RestoreSeconds > 900 || math.IsNaN(item.RestoreSeconds) || item.OpenBaoVersion == "" || len(item.OpenBaoVersion) > 64 {
				return result, fmt.Errorf("invalid verified backup metadata")
			}
			seen[item.ID] = true
			result.Backups = append(result.Backups, Backup{ID: item.ID, Created: item.Created, Bytes: item.Bytes, RestoreSeconds: item.RestoreSeconds, OpenBaoVersion: item.OpenBaoVersion})
		}
	}
	sort.Slice(result.Backups, func(i, j int) bool { return result.Backups[i].Created.After(result.Backups[j].Created) })
	jobs, err := s.cluster.BatchV1().Jobs(Namespace).List(ctx, metav1.ListOptions{LabelSelector: "app.kubernetes.io/name=openbao-recovery", Limit: 100})
	if err != nil {
		return result, fmt.Errorf("list recovery operations: %w", err)
	}
	result.JobsComplete = jobs.Continue == ""
	for i := range jobs.Items {
		result.Jobs = append(result.Jobs, summarize(&jobs.Items[i]))
	}
	sort.Slice(result.Jobs, func(i, j int) bool { return result.Jobs[i].CreatedAt.After(result.Jobs[j].CreatedAt) })
	if len(result.Jobs) > 20 {
		result.Jobs = result.Jobs[:20]
		result.JobsComplete = false
	}
	return result, nil
}
