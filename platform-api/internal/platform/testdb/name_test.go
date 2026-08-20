package testdb

import (
	"strings"
	"testing"
)

// The regression: two packages had a test of the same name — audit's and
// write's TestAnUnauditableOperationDoesNotProceed, the second copied from the
// first — and the old databaseName built its name from t.Name() alone, so both
// resolved to one database. Run concurrently by `go test ./...`, one of them
// lost the non-atomic DROP-then-CREATE and failed on a duplicate key.
//
// In-package rather than external, because what needs pinning is the naming,
// not the pool, and the naming is unexported on purpose.
func TestTheSameTestNameInTwoPackagesGetsTwoDatabases(t *testing.T) {
	audit := databaseName(t, "/repo/platform-api/internal/platform/audit")
	write := databaseName(t, "/repo/platform-api/internal/platform/write")
	if audit == write {
		t.Fatalf("both packages resolved to %q", audit)
	}
	for _, name := range []string{audit, write} {
		if len(name) > 63 {
			t.Errorf("%q is %d bytes; Postgres truncates identifiers at 63", name, len(name))
		}
	}
}

// Every module has an internal/repository, so the readable half of the name
// cannot be the directory's base name alone.
func TestTwoPackagesWithTheSameBaseNameGetTwoDatabases(t *testing.T) {
	tickets := databaseName(t, "/repo/internal/modules/tickets/internal/repository")
	crm := databaseName(t, "/repo/internal/modules/crm/internal/repository")
	if tickets == crm {
		t.Fatalf("both repositories resolved to %q", tickets)
	}
	if !strings.Contains(tickets, "repository") {
		t.Errorf("%q does not name the package it belongs to", tickets)
	}
}

// Truncation must cut the test name, never the prefix — a truncation that ate
// the package segment would bring the collision back for long names only,
// which is the worst possible place for it to hide.
//
// The long name comes from a subtest, because t.Name() is the only way
// databaseName learns a name and it cannot be handed one directly.
func TestALongTestNameKeepsItsPackagePrefix(t *testing.T) {
	long := strings.Repeat("Verylongtestname", 8)
	for _, c := range []struct{ pkgDir, wantPrefix string }{
		{"/repo/internal/platform/audit", "pa_test_audit_"},
		{"/repo/internal/platform/write", "pa_test_write_"},
	} {
		t.Run(long, func(sub *testing.T) {
			name := databaseName(sub, c.pkgDir)
			if len(name) > 63 {
				sub.Fatalf("%q is %d bytes; Postgres truncates identifiers at 63", name, len(name))
			}
			if !strings.HasPrefix(name, c.wantPrefix) {
				sub.Errorf("truncation ate the package prefix: %q, want it to start %q", name, c.wantPrefix)
			}
		})
	}
}
