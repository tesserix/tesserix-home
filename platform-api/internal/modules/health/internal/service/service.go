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
	// ReadTimeout bounds one cluster read. The read happens under the mutex,
	// so this is also the worst case a queued caller can be made to wait for
	// a refresh someone else started.
	ReadTimeout = 5 * time.Second
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
	// lastFailure and failureReason are the negative cache: a read that
	// failed is remembered for the same window as one that succeeded.
	lastFailure   time.Time
	failureReason string
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

	// A FAILED read is cached for the same window as a successful one.
	// Without this, a cluster that cannot be read is re-read on every page
	// render — and because the read happens under this lock, those attempts
	// serialise: the Nth concurrent render waits N x ReadTimeout. Negative
	// caching is what keeps the lock's cost bounded instead of proportional
	// to traffic.
	if !s.lastFailure.IsZero() && now.Sub(s.lastFailure) < FreshFor {
		return s.afterFailure(now)
	}

	// Detached from the caller's context ON PURPOSE, with its own deadline.
	// ctx belongs to one operator's page render; if they navigate away it is
	// cancelled, and with the read under the lock that would fail this
	// refresh AND waste the wait of everyone queued behind it. A refresh is
	// shared work, so it does not inherit one caller's lifetime.
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ReadTimeout)
	defer cancel()

	workloads, err := s.source.Deployments(readCtx)
	if err == nil {
		var databases []cluster.Database
		databases, err = s.source.Databases(readCtx)
		if err == nil {
			s.cached = domain.Classify(workloads, databases)
			s.cachedAt = now
			s.hasValue = true
			s.lastFailure = time.Time{}
			s.failureReason = ""
			return Result{Snapshot: s.cached, CheckedAt: now}
		}
	}

	s.lastFailure = now
	s.failureReason = err.Error()
	return s.afterFailure(now)
}

// afterFailure decides what to serve when the cluster could not be read.
// Called with s.mu held.
func (s *Service) afterFailure(now time.Time) Result {
	if s.hasValue && now.Sub(s.cachedAt) < StaleCeiling {
		return Result{Snapshot: s.cached, Stale: true, CheckedAt: s.cachedAt}
	}
	s.hasValue = false
	return Result{
		Snapshot:  domain.Unmeasured("the cluster could not be read: " + s.failureReason),
		CheckedAt: now,
	}
}
