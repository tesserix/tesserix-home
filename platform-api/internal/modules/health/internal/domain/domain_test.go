package domain_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/domain"
)

func TestClassify(t *testing.T) {
	tests := []struct {
		name      string
		workloads []cluster.Workload
		databases []cluster.Database
		want      domain.State
	}{
		{
			name:      "everything ready is healthy",
			workloads: []cluster.Workload{{Name: "console", Desired: 2, Ready: 2}},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
			want:      domain.StateHealthy,
		},
		{
			name:      "a workload short of its desired replicas is degraded",
			workloads: []cluster.Workload{{Name: "console", Desired: 3, Ready: 1}},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
			want:      domain.StateDegraded,
		},
		{
			name:      "a database short of its instances is degraded",
			workloads: []cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
			databases: []cluster.Database{{Name: "pg", Instances: 3, Ready: 2}},
			want:      domain.StateDegraded,
		},
		{
			// A Deployment deliberately scaled to zero wants nothing and has
			// nothing. It is not broken, and reporting it as such would train
			// operators to ignore the indicator.
			name:      "a workload desiring zero replicas is not degraded",
			workloads: []cluster.Workload{{Name: "quiet", Desired: 0, Ready: 0}},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
			want:      domain.StateHealthy,
		},
		{
			// The DELIBERATE asymmetry with the workload case above. A
			// Deployment at zero replicas is switched off on purpose; a CNPG
			// Cluster reporting zero instances is initialising or has not
			// populated its status, and is serving nothing either way.
			name:      "a database with zero instances is degraded, unlike a zero-replica workload",
			workloads: []cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
			databases: []cluster.Database{{Name: "pg", Instances: 0, Ready: 0}},
			want:      domain.StateDegraded,
		},
		{
			// THE CENTRAL CASE. A namespace with no workloads is not a
			// healthy namespace; it is a read that returned nothing, which is
			// what a silently-broken read looks like. Reporting it healthy is
			// the parked plane rendered green, which is the failure this
			// entire feature was written to prevent.
			name:      "no workloads at all is unmeasured, never healthy",
			workloads: nil,
			databases: nil,
			want:      domain.StateUnmeasured,
		},
		{
			// Workloads present, databases absent. CNPG could be uninstalled
			// or the read could have silently returned nothing. Either way
			// nothing measured the databases, so the estate is not "healthy".
			name:      "workloads without databases is unmeasured",
			workloads: []cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
			databases: nil,
			want:      domain.StateUnmeasured,
		},
		{
			// `>=`, not `==`. A Deployment mid-rollout can briefly report more
			// ready than desired, and reporting that as broken would make the
			// indicator cry wolf on every deploy.
			name:      "a workload with more ready than desired is not degraded",
			workloads: []cluster.Workload{{Name: "console", Desired: 2, Ready: 3}},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
			want:      domain.StateHealthy,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := domain.Classify(test.workloads, test.databases)
			if got.State != test.want {
				t.Errorf("Classify = %q, want %q (reason: %q)", got.State, test.want, got.Reason)
			}
		})
	}
}

func TestClassifyCountsWhatItSaw(t *testing.T) {
	got := domain.Classify(
		[]cluster.Workload{
			{Name: "a", Desired: 1, Ready: 1},
			{Name: "b", Desired: 2, Ready: 0},
			{Name: "c", Desired: 3, Ready: 3},
		},
		[]cluster.Database{
			{Name: "pg", Instances: 1, Ready: 1},
			{Name: "pg2", Instances: 2, Ready: 0},
		},
	)
	if got.Workloads.Total != 3 || got.Workloads.Ready != 2 {
		t.Errorf("workloads = %+v, want {Total:3 Ready:2}", got.Workloads)
	}
	if got.Databases.Total != 2 || got.Databases.Ready != 1 {
		t.Errorf("databases = %+v, want {Total:2 Ready:1}", got.Databases)
	}
}

func TestDegradedNamesWhatIsWrong(t *testing.T) {
	// The reason reaches an operator. "something is degraded" sends them to
	// the cluster to find out what; naming it means they already know.
	got := domain.Classify(
		[]cluster.Workload{{Name: "mp-orders", Desired: 2, Ready: 0}},
		[]cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
	)
	if !strings.Contains(got.Reason, "mp-orders") {
		t.Errorf("reason = %q, want it to name mp-orders", got.Reason)
	}
}

func TestUnmeasuredCarriesItsReason(t *testing.T) {
	got := domain.Unmeasured("the API server answered 403")
	if got.State != domain.StateUnmeasured {
		t.Errorf("State = %q, want unmeasured", got.State)
	}
	if !strings.Contains(got.Reason, "403") {
		t.Errorf("reason = %q, want the cause preserved", got.Reason)
	}
}
