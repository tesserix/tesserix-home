package featureflags

import "testing"

func TestCreationReconciliationPreservesConcurrentProviderOwnership(t *testing.T) {
	c := command{ID: "create-one", Reason: "Provision reviewed definition", Enabled: false, baseVersion: 0}
	f := feature{Description: "Helivanta deployment catalogue", Revision: revision{Version: 1}}
	state, code := reconciledOutcome(c, f, false)
	if state != "succeeded" || code != "ALREADY_PROVISIONED" {
		t.Fatalf("operator-created definition stranded the command: %s %s", state, code)
	}
	state, code = reconciledOutcome(c, f, true)
	if state != "failed" || code != "PROVISIONED_AND_CHANGED" {
		t.Fatalf("concurrent activation must be preserved: %s %s", state, code)
	}
	c.baseVersion = 1
	f.Revision.Version = 2
	state, code = reconciledOutcome(c, f, false)
	if state != "" || code != "" {
		t.Fatalf("non-attributable updates must remain unresolved: %s %s", state, code)
	}
	f.Revision.Comment = "Tesserix command create-one: Provision reviewed definition"
	state, code = reconciledOutcome(c, f, false)
	if state != "succeeded" || code != "CONFIRMED" {
		t.Fatalf("attributable update not confirmed: %s %s", state, code)
	}
}
