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
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1, Phase: domain.HealthyPhase}},
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
			//
			// The second workload is not decoration. This subtest is about ONE
			// workload at zero inside a live estate; with `quiet` alone the
			// fixture is also an estate where NOTHING desires a replica, which
			// the all-zero rule below now — correctly — calls unmeasured. The
			// intent and the assertion are unchanged; the fixture is now only
			// the case the name claims.
			name: "a workload desiring zero replicas is not degraded",
			workloads: []cluster.Workload{
				{Name: "quiet", Desired: 0, Ready: 0},
				{Name: "console", Desired: 1, Ready: 1},
			},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1, Phase: domain.HealthyPhase}},
			want:      domain.StateHealthy,
		},
		{
			name: "an estate with every workload scaled to zero is unmeasured",
			workloads: []cluster.Workload{
				{Name: "console", Desired: 0, Ready: 0},
				{Name: "platform-api", Desired: 0, Ready: 0},
			},
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1}},
			want:      domain.StateUnmeasured,
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
			databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1, Phase: domain.HealthyPhase}},
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
			{Name: "pg", Instances: 1, Ready: 1, Phase: domain.HealthyPhase},
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

func TestAnUnmeasuredReadingStillNamesWhatItSawDown(t *testing.T) {
	// The RBAC Role grants `apps/deployments` and `postgresql.cnpg.io/clusters`
	// as two separate rules, so the CNPG list coming back empty while the
	// Deployments read fine is a real shape, not a hypothetical. `unmeasured`
	// is the honest state for it — but the workloads observed down are the
	// most actionable fact in the answer, and returning before they are
	// assembled discards them.
	got := domain.Classify(
		[]cluster.Workload{{Name: "mp-orders", Desired: 2, Ready: 0}},
		nil,
	)
	if got.State != domain.StateUnmeasured {
		t.Errorf("State = %q, want unmeasured with no databases measured", got.State)
	}
	if !strings.Contains(got.Reason, "mp-orders") {
		t.Errorf("reason = %q, want it to still name mp-orders", got.Reason)
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

func TestItemsSurviveClassifySortedByName(t *testing.T) {
	// Deliberately fed out of name order, so a pass here cannot be an
	// accident of input order matching output order.
	got := domain.Classify(
		[]cluster.Workload{
			{Name: "platform-api", Desired: 1, Ready: 1},
			{Name: "console", Desired: 2, Ready: 2},
		},
		[]cluster.Database{
			{Name: "tesserix-postgres", Instances: 1, Ready: 1, Phase: domain.HealthyPhase},
			{Name: "analytics-postgres", Instances: 2, Ready: 2, Phase: domain.HealthyPhase},
		},
	)

	wantWorkloads := []domain.WorkloadItem{
		{Name: "console", Desired: 2, Ready: 2},
		{Name: "platform-api", Desired: 1, Ready: 1},
	}
	if len(got.WorkloadItems) != len(wantWorkloads) {
		t.Fatalf("WorkloadItems = %+v, want %+v", got.WorkloadItems, wantWorkloads)
	}
	for i, want := range wantWorkloads {
		if got.WorkloadItems[i] != want {
			t.Errorf("WorkloadItems[%d] = %+v, want %+v", i, got.WorkloadItems[i], want)
		}
	}

	wantDatabases := []domain.DatabaseItem{
		{Name: "analytics-postgres", Instances: 2, Ready: 2, Phase: domain.HealthyPhase},
		{Name: "tesserix-postgres", Instances: 1, Ready: 1, Phase: domain.HealthyPhase},
	}
	if len(got.DatabaseItems) != len(wantDatabases) {
		t.Fatalf("DatabaseItems = %+v, want %+v", got.DatabaseItems, wantDatabases)
	}
	for i, want := range wantDatabases {
		if got.DatabaseItems[i] != want {
			t.Errorf("DatabaseItems[%d] = %+v, want %+v", i, got.DatabaseItems[i], want)
		}
	}
}

func TestADatabaseWithMatchingCountsButAWrongPhaseIsDegraded(t *testing.T) {
	// The deferred finding from #332's review: counts alone are not enough.
	// A cluster can report every instance ready while CNPG itself says the
	// cluster is not settled — mid-failover, for example — and that is not
	// healthy.
	got := domain.Classify(
		[]cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
		[]cluster.Database{{Name: "tesserix-postgres", Instances: 1, Ready: 1, Phase: "Failing over"}},
	)
	if got.State != domain.StateDegraded {
		t.Fatalf("State = %q, want degraded — matching counts do not mean healthy when the phase is not", got.State)
	}
	if !strings.Contains(got.Reason, "Failing over") {
		t.Errorf("reason = %q, want it to name the phase", got.Reason)
	}
	if !strings.Contains(got.Reason, "tesserix-postgres") {
		t.Errorf("reason = %q, want it to name the database", got.Reason)
	}
	if got.Databases.Ready != 0 {
		t.Errorf("Databases.Ready = %d, want 0 — a wrong phase must not count as ready", got.Databases.Ready)
	}
}
