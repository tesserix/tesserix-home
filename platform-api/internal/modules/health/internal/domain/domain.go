// Package domain decides what a cluster reading means.
//
// Separated from the reader because this is the part worth testing hardest and
// the part that must not need a server to test. Every rule here is a judgement
// someone can disagree with; each one is therefore written down with why.
package domain

import (
	"fmt"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
)

// State is what the indicator renders.
type State string

const (
	StateHealthy    State = "healthy"
	StateDegraded   State = "degraded"
	StateUnmeasured State = "unmeasured"
)

// Counts is how much of a thing there is and how much of it is ready.
type Counts struct {
	Total int
	Ready int
}

// Snapshot is one classification.
type Snapshot struct {
	State State
	// Reason is empty when healthy, and names the specific workload or
	// database otherwise.
	Reason    string
	Workloads Counts
	Databases Counts
}

// Unmeasured is the snapshot for "nothing measured this".
func Unmeasured(reason string) Snapshot {
	return Snapshot{State: StateUnmeasured, Reason: reason}
}

// Classify turns a cluster reading into a state.
//
// # An empty reading is unmeasured, not healthy
//
// The `tesserix` namespace always contains workloads. A reading with none did
// not observe an empty estate; it failed to observe the estate. Because the
// reader already turns a non-200 into an error, the shape that reaches here
// with zero items is the more insidious one — a 200 with nothing in it, which
// is what an RBAC grant scoped to the wrong namespace produces.
//
// The same applies to databases considered separately: workloads read fine and
// databases came back empty means the CNPG half was not measured, and an
// indicator that says "healthy" while blind to every database is telling an
// operator something it does not know.
func Classify(workloads []cluster.Workload, databases []cluster.Database) Snapshot {
	snapshot := Snapshot{
		Workloads: Counts{Total: len(workloads)},
		Databases: Counts{Total: len(databases)},
	}

	var problems []string

	for _, workload := range workloads {
		// Desired 0 is switched off on purpose, and wanting nothing is
		// satisfied by having nothing.
		if workload.Ready >= workload.Desired {
			snapshot.Workloads.Ready++
			continue
		}
		problems = append(problems, fmt.Sprintf("%s %d/%d ready",
			workload.Name, workload.Ready, workload.Desired))
	}

	// Note the `Instances > 0` guard, which the workload loop deliberately
	// does NOT have. A Deployment desiring zero replicas is switched off on
	// purpose and is satisfied by having nothing. A CNPG Cluster reporting
	// zero instances is not an intentional state — it is initialising, or its
	// status has not populated — and it is serving no queries either way.
	// Two resources, two rules, on purpose.
	for _, database := range databases {
		if database.Ready >= database.Instances && database.Instances > 0 {
			snapshot.Databases.Ready++
			continue
		}
		problems = append(problems, fmt.Sprintf("%s %d/%d instances ready",
			database.Name, database.Ready, database.Instances))
	}

	if len(workloads) == 0 || len(databases) == 0 {
		snapshot.State = StateUnmeasured
		snapshot.Reason = "the cluster read returned nothing to measure"
		return snapshot
	}

	if len(problems) > 0 {
		snapshot.State = StateDegraded
		snapshot.Reason = strings.Join(problems, "; ")
		return snapshot
	}

	snapshot.State = StateHealthy
	return snapshot
}
