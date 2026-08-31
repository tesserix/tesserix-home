package service

import "testing"

// console_audit_log.actor holds subjects, and this is where that is kept true
// from Go.
//
// The regression it guards is a real one that shipped: auditActor returned
// a.Email when it was non-empty, which was harmless only because an operator's
// email was always empty until #450 began resolving it from userinfo. #450
// would have started writing emails into a column whose two existing rows are
// subjects, and whose contract apps/console/lib/crm-write.ts enforces on the
// other side — the same divergence that wrapper was lifted out to prevent.
//
// The stronger half of the guarantee is not in this assertion but in the type:
// Actor has no email field left for auditActor to return, so a change that
// reintroduced one would have to add the field back deliberately. This pins
// the behaviour; the compiler pins the shape.
func TestAnAuditActorIsTheSubject(t *testing.T) {
	const subject = "386888878927118733"
	if got := (Actor{Subject: subject}).auditActor(); got != subject {
		t.Fatalf("auditActor() = %q, want the subject %q", got, subject)
	}
}
