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
