package featureflags

import "testing"

func TestRecoveryNeverRetriesUncertainDeliveryOrCancelsDispatchedChanges(t *testing.T) {
	for _, state := range []string{"queued", "dispatching", "in_doubt", "succeeded", "failed"} {
		c := command{Actor: "requester", State: state}
		if issue := recoveryAllowed(c, "other-manager", true); issue == nil || issue.Status != 403 {
			t.Fatalf("another manager can resume %s: %v", state, issue)
		}
		if issue := recoveryAllowed(c, "requester", true); issue != nil {
			t.Fatalf("requester cannot inspect/replay %s: %v", state, issue)
		}
		issue := recoveryAllowed(c, "other-manager", false)
		if (issue == nil) != (state == "queued") {
			t.Fatalf("unsafe cancellation for %s: %v", state, issue)
		}
	}
	if issue := recoveryAllowed(command{State: "failed", Code: "CANCELED_BEFORE_DISPATCH"}, "manager", false); issue != nil {
		t.Fatalf("cancellation replay denied: %v", issue)
	}
}
