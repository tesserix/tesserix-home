// Package domain decides what a cluster reading means.
//
// Separated from the reader because this is the part worth testing hardest and
// the part that must not need a server to test. Every rule here is a judgement
// someone can disagree with; each one is therefore written down with why.
package domain

import (
	"fmt"
	"sort"
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

// WorkloadItem is one Deployment's detail, carried through to the wire so an
// operator can see which workload is short without leaving the page.
type WorkloadItem struct {
	Name    string
	Desired int
	Ready   int
	// OK is this module's own verdict on this one row, set by the same
	// statement that decides whether the row counts towards Counts.Ready.
	// It exists so no consumer has to re-derive the rule: a renderer that
	// re-implements "ready >= desired" is a second copy of a rule that has
	// already changed once, and the first time the two disagree the page
	// shows a row marked fine directly under a summary that counts it bad.
	OK bool
}

// DatabaseItem is one CNPG Cluster's detail, including the phase CNPG itself
// reports — the fact that decides whether a cluster with matching counts is
// actually healthy.
type DatabaseItem struct {
	Name      string
	Instances int
	Ready     int
	Phase     string
	// OK is this row's verdict. A database has THREE ways to fail — short
	// counts, zero instances, and a phase that is not a healthy one — and
	// only the code that applies all three gets to say. See WorkloadItem.OK.
	OK bool
}

// Snapshot is one classification.
type Snapshot struct {
	State State
	// Reason is empty when healthy, and names the specific workload or
	// database otherwise.
	Reason        string
	Workloads     Counts
	Databases     Counts
	WorkloadItems []WorkloadItem
	DatabaseItems []DatabaseItem
}

// The CNPG cluster phases this module treats as healthy.
//
// These are hardcoded ENGLISH STRINGS from a third-party controller, not an
// API we own. They mirror CNPG's own constants in
// `api/v1/cluster_types.go` — `PhaseHealthy` and `PhaseUpgradeDelayed` — and
// that file is where to look first if a CNPG upgrade turns the estate amber
// with a reason that looks like a real problem: a reworded phase string
// fails safe (amber, not green), which is the right direction, but it fails
// PERMANENTLY, so the breadcrumb matters.
const (
	// HealthyPhase is the phase a settled cluster reports, and the one the
	// degraded reason names as the wanted value. Verified against the
	// production cluster.
	HealthyPhase = "Cluster in healthy state"
	// UpgradeDelayedPhase is a rolling update that CNPG has not been able to
	// carry out — a PodDisruptionBudget in the way, a node-maintenance
	// window, or `primaryUpdateStrategy: supervised` waiting on a human.
	UpgradeDelayedPhase = "Cluster upgrade delayed"
)

// healthyPhases is the SET of phases treated as healthy, deliberately not
// the complement of a list of bad ones: an unknown future phase must read as
// a problem, not as fine, which is the fail-safe direction and matches this
// module's whole premise.
//
// Why UpgradeDelayedPhase is in it: the cluster is serving every query, and
// CNPG can sit in this phase for days while a maintenance window or a
// supervised switchover waits. Degrading on it means an amber estate
// indicator indefinitely — and a permanently amber indicator is one
// operators learn to ignore, which is this feature's own failure mode
// arrived at from the opposite direction. It is the database twin of the
// workload rule's `>=`, which exists so the indicator does not cry wolf on
// every deploy; without this, the database rule cried wolf on every CNPG
// rollout.
//
// "Waiting for user action" is deliberately NOT here. The primary is
// serving, but action genuinely is required, so amber is honest there.
var healthyPhases = map[string]struct{}{
	HealthyPhase:        {},
	UpgradeDelayedPhase: {},
}

func isHealthyPhase(phase string) bool {
	_, ok := healthyPhases[phase]
	return ok
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
//
// # And an estate desiring no replicas at all is empty, not healthy
//
// One Deployment at zero is switched off on purpose. Every Deployment at zero
// is a namespace with nothing running in it, which one bad rollout or a sync
// against a broken values file is enough to produce — and "12 of 12 workloads
// ready" over zero pods is the parked plane again.
func Classify(workloads []cluster.Workload, databases []cluster.Database) Snapshot {
	snapshot := Snapshot{
		Workloads: Counts{Total: len(workloads)},
		Databases: Counts{Total: len(databases)},
	}

	var problems []string

	// The total desired across the whole namespace, for the all-zero rule
	// below. Per-workload, zero is a legitimate state; in aggregate it is not.
	desired := 0

	for _, workload := range workloads {
		desired += workload.Desired
		// ONE decision, used three ways: the row's verdict, the ready
		// counter, and whether this workload is named as a problem. The row
		// and the summary cannot disagree by construction.
		//
		// Desired 0 is switched off on purpose, and wanting nothing is
		// satisfied by having nothing.
		ok := workload.Ready >= workload.Desired
		snapshot.WorkloadItems = append(snapshot.WorkloadItems, WorkloadItem{
			Name: workload.Name, Desired: workload.Desired, Ready: workload.Ready, OK: ok,
		})
		if ok {
			snapshot.Workloads.Ready++
			continue
		}
		problems = append(problems, fmt.Sprintf("%s %d/%d ready",
			workload.Name, workload.Ready, workload.Desired))
	}
	sort.Slice(snapshot.WorkloadItems, func(i, j int) bool {
		return snapshot.WorkloadItems[i].Name < snapshot.WorkloadItems[j].Name
	})

	// Note the `Instances > 0` guard, which the workload loop deliberately
	// does NOT have. A Deployment desiring zero replicas is switched off on
	// purpose and is satisfied by having nothing. A CNPG Cluster reporting
	// zero instances is not an intentional state — it is initialising, or its
	// status has not populated — and it is serving no queries either way.
	// Two resources, two rules, on purpose.
	for _, database := range databases {
		countsOK := database.Ready >= database.Instances && database.Instances > 0
		// Counts matching is not enough — see below — so the row's verdict
		// is BOTH rules, which is exactly the condition under which
		// Databases.Ready is incremented at the bottom of this loop.
		ok := countsOK && isHealthyPhase(database.Phase)
		snapshot.DatabaseItems = append(snapshot.DatabaseItems, DatabaseItem{
			Name: database.Name, Instances: database.Instances, Ready: database.Ready,
			Phase: database.Phase, OK: ok,
		})

		if !countsOK {
			problems = append(problems, fmt.Sprintf("%s %d/%d instances ready",
				database.Name, database.Ready, database.Instances))
			continue
		}
		// Counts matching is not enough. CNPG can report every instance ready
		// while the cluster itself is mid-failover or otherwise not settled —
		// the phase is the fact that says whether it actually is. Treated as
		// "not one of the healthy phases" rather than a list of known-bad
		// phases, so an unknown future phase reads as a problem, not as fine.
		if !isHealthyPhase(database.Phase) {
			// An ABSENT phase and a WRONG phase are different facts and get
			// different sentences. `reports phase ""` reads like a bug in
			// this code; "has not reported a phase yet" is what actually
			// happened, and tells the operator to wait rather than to
			// investigate.
			if database.Phase == "" {
				problems = append(problems, fmt.Sprintf(
					"%s has not reported a phase yet (want %q)",
					database.Name, HealthyPhase))
			} else {
				problems = append(problems, fmt.Sprintf(
					"%s reports phase %q, not %q",
					database.Name, database.Phase, HealthyPhase))
			}
			continue
		}
		snapshot.Databases.Ready++
	}
	sort.Slice(snapshot.DatabaseItems, func(i, j int) bool {
		return snapshot.DatabaseItems[i].Name < snapshot.DatabaseItems[j].Name
	})

	if len(workloads) == 0 || len(databases) == 0 {
		snapshot.State = StateUnmeasured
		snapshot.Reason = "the cluster read returned nothing to measure"
		// Anything that WAS measured still gets named. `unmeasured` is the
		// honest state, but the workloads observed down are the most
		// actionable fact in the answer and dropping them helps nobody.
		if len(problems) > 0 {
			snapshot.Reason += "; " + strings.Join(problems, "; ")
		}
		return snapshot
	}

	// The per-workload rule above treats one Deployment at zero as switched
	// off on purpose, which is right. It does not stretch to ALL of them: an
	// estate where nothing desires a single replica was not observed running,
	// it was observed empty. Either a rollout emptied the namespace or the
	// reading is not describing a live estate, and neither is "healthy".
	if desired == 0 {
		snapshot.State = StateUnmeasured
		snapshot.Reason = "no workload in the namespace desires a replica"
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
