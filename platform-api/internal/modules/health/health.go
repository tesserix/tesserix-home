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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
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

// Re-exported so the composition root can build a Source and hand it over
// without importing this module's internals, which Go forbids from outside
// this subtree. Aliases rather than new types: a wrapper type would need
// conversion at every call site for no benefit.
type (
	// Source is what the module reads to answer a health request.
	Source = service.Source
	// Workload is one Deployment as the module sees it.
	Workload = cluster.Workload
	// Database is one CNPG Cluster as the module sees it.
	Database = cluster.Database
	// ClusterConfig is how to reach the Kubernetes API.
	ClusterConfig = cluster.Config
)

// NewClusterSource builds a Source that reads the Kubernetes API, and reports
// the namespace it will read.
//
// The namespace is returned rather than exposed as a method on Source. It is
// a fact about the CONSTRUCTION — established once, from the pod's own
// ServiceAccount directory — not a question worth asking a Source later, and
// widening the interface for one log line would make every implementation
// (including the composition root's unmeasured stand-in) carry a method
// nothing reads.
//
// Returns an untyped nil on failure rather than a nil *cluster.Reader. A nil
// pointer assigned into an interface produces a NON-nil interface holding a
// nil pointer, so `source != nil` would be true and the first method call
// would panic.
func NewClusterSource(cfg ClusterConfig) (Source, string, error) {
	reader, err := cluster.New(cfg)
	if err != nil {
		return nil, "", err
	}
	return reader, reader.Namespace(), nil
}
