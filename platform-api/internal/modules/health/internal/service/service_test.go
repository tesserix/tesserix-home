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

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

func newClock() *clock {
	return &clock{t: time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)}
}

func TestASecondCallInsideTheWindowDoesNotReadTheCluster(t *testing.T) {
	source, c := healthy(), newClock()
	svc := service.New(source, c.now)

	first := svc.Health(t.Context())
	c.add(5 * time.Second)
	second := svc.Health(t.Context())

	if source.calls != 1 {
		t.Errorf("read the cluster %d times, want 1 — the header renders on every page", source.calls)
	}
	// CheckedAt is when the READING was taken, not when it was served. A
	// cache hit five seconds later still reports the original moment;
	// stamping the serve time here would make every cached answer look
	// freshly measured.
	if !second.CheckedAt.Equal(first.CheckedAt) {
		t.Errorf("CheckedAt = %v on the cached call, want the original %v",
			second.CheckedAt, first.CheckedAt)
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
	// The stale value keeps the timestamp of the reading it actually came
	// from. This is what makes `stale` legible downstream — the console can
	// say HOW old, not merely that it is old.
	if !got.CheckedAt.Equal(first.CheckedAt) {
		t.Errorf("CheckedAt = %v on the stale serve, want the original %v",
			got.CheckedAt, first.CheckedAt)
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

func TestAFailingReadIsNotRetriedOnEveryCall(t *testing.T) {
	source, c := healthy(), newClock()
	source.err = errors.New("the API server answered 503")
	svc := service.New(source, c.now)

	svc.Health(t.Context())
	c.add(5 * time.Second)
	svc.Health(t.Context())

	if source.calls != 1 {
		t.Errorf("read the cluster %d times, want 1 — a failing read held under "+
			"the lock and retried per render costs N x ReadTimeout", source.calls)
	}
}
