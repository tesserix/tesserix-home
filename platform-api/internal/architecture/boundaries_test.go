package architecture_test

import (
	"os"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/tesserix/tesserix-home/platform-api/internal/architecture"
)

const modPath = "github.com/tesserix/tesserix-home/platform-api"

func file(imports ...string) *fstest.MapFile {
	var b strings.Builder
	b.WriteString("package p\n\nimport (\n")
	for _, imp := range imports {
		b.WriteString("\t\"" + imp + "\"\n")
	}
	b.WriteString(")\n")
	return &fstest.MapFile{Data: []byte(b.String())}
}

// The acceptance criterion from #277: a deliberate cross-module import must
// fail. If this test ever passes for the wrong reason — because the checker
// silently stopped finding files, say — the sibling tests below are what
// notice.
func TestCrossModuleImportIsRejected(t *testing.T) {
	fsys := fstest.MapFS{
		"internal/modules/billing/billing.go": file(
			modPath + "/internal/modules/tickets",
		),
	}

	got, err := architecture.Check(fsys)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want exactly 1 violation, got %d: %v", len(got), got)
	}
	if got[0].FromModule != "billing" || got[0].ToModule != "tickets" {
		t.Errorf("want billing -> tickets, got %s -> %s", got[0].FromModule, got[0].ToModule)
	}
	// The message must name the file and the import, because the person
	// reading it in a CI log has neither the graph nor this test in front of
	// them.
	msg := got[0].String()
	for _, want := range []string{"internal/modules/billing/billing.go", "billing", "tickets"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q does not mention %q", msg, want)
		}
	}
}

// Reaching into a sibling's internals is the same violation, not a worse one —
// though the compiler also refuses this independently. Both mechanisms are
// meant to cover it; only one of them is exercised here.
func TestReachingIntoASiblingsInternalsIsRejected(t *testing.T) {
	fsys := fstest.MapFS{
		"internal/modules/billing/billing.go": file(
			modPath + "/internal/modules/tickets/internal/repository",
		),
	}

	got, err := architecture.Check(fsys)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 violation, got %d: %v", len(got), got)
	}
	if got[0].ToModule != "tickets" {
		t.Errorf("want target module tickets, got %q", got[0].ToModule)
	}
}

// A module importing its own internals is the intended shape, and a checker
// that flagged it would be unusable.
func TestModuleMayImportItsOwnInternals(t *testing.T) {
	fsys := fstest.MapFS{
		"internal/modules/tickets/tickets.go": file(
			modPath+"/internal/modules/tickets/internal/repository",
			modPath+"/internal/modules/tickets/internal/domain",
		),
	}

	got, err := architecture.Check(fsys)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("own internals must be allowed, got %v", got)
	}
}

// The kernel is the sanctioned way for modules to share anything, so importing
// it must stay free. If this ever starts failing, modules have no legal way to
// reach a database handle and the rule becomes unworkable rather than strict.
func TestModuleMayImportThePlatformKernel(t *testing.T) {
	fsys := fstest.MapFS{
		"internal/modules/tickets/tickets.go": file(
			modPath+"/internal/platform/httpx",
			modPath+"/internal/platform/database",
			"context",
			"github.com/gin-gonic/gin",
		),
	}

	got, err := architecture.Check(fsys)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("kernel and third-party imports must be allowed, got %v", got)
	}
}

// Composition happens in cmd/server, which by definition imports every module.
// It is not under modules/, so it is not a module, and the rule does not
// apply to it. This is the deliberate escape hatch and it must stay open.
func TestComposingEveryModuleFromCmdIsAllowed(t *testing.T) {
	fsys := fstest.MapFS{
		"cmd/server/main.go": file(
			modPath+"/internal/modules/tickets",
			modPath+"/internal/modules/billing",
		),
	}

	got, err := architecture.Check(fsys)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("cmd/server composes modules by design, got %v", got)
	}
}

// modules/doc.go carries the rule itself and sits directly under modules/.
// Treating a file there as a module named "doc.go" would be nonsense, and
// worse, would let a real violation hide behind a confusing name.
func TestFilesDirectlyUnderModulesAreNotModules(t *testing.T) {
	fsys := fstest.MapFS{
		"internal/modules/doc.go": file(modPath + "/internal/modules/tickets"),
	}

	got, err := architecture.Check(fsys)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("modules/doc.go is not a module, got %v", got)
	}
}

func TestViolationsAreReportedForEveryOffendingFile(t *testing.T) {
	fsys := fstest.MapFS{
		"internal/modules/billing/a.go": file(modPath + "/internal/modules/tickets"),
		"internal/modules/billing/b.go": file(modPath + "/internal/modules/audit"),
		"internal/modules/audit/c.go":   file(modPath + "/internal/modules/tickets"),
	}

	got, err := architecture.Check(fsys)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3 violations, got %d: %v", len(got), got)
	}
	// Sorted by file then import, so a CI log reads the same way twice.
	if got[0].File != "internal/modules/audit/c.go" {
		t.Errorf("violations are not sorted by file: %v", got)
	}
}

// A test file crossing the boundary is the same coupling as production code
// doing it. Exempting tests is how the first exception gets made.
func TestTestFilesAreNotExempt(t *testing.T) {
	fsys := fstest.MapFS{
		"internal/modules/billing/billing_test.go": file(modPath + "/internal/modules/tickets"),
	}

	got, err := architecture.Check(fsys)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("test files must be checked too, got %v", got)
	}
}

// The rule, applied to this repository. Today it passes vacuously — there are
// no modules yet — which is the entire point of landing it now.
func TestThisServiceHasNoCrossModuleImports(t *testing.T) {
	root := os.DirFS("../..")

	got, err := architecture.Check(root)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(got) > 0 {
		var b strings.Builder
		b.WriteString("cross-module imports are forbidden — see internal/modules/doc.go\n")
		for _, v := range got {
			b.WriteString("  " + v.String() + "\n")
		}
		t.Fatal(b.String())
	}
}
