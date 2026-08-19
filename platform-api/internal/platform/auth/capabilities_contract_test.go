package auth

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The vocabulary exists in three places: Zitadel's project roles,
// packages/platform-auth/src/capabilities.ts, and capabilities.go. Two of those
// are code, so drift between them can be a failing test rather than a
// production discovery — this is that test.
//
// It reads the TypeScript source directly. That is deliberate: a hand-copied
// list here would be a fourth copy, and the thing most likely to drift is
// exactly the copy nobody is looking at.
//
// The third copy — Zitadel — cannot be checked from here without the read-only
// Management API credential that #211 is blocked on. Until then the runtime
// guard is ErrNoRoles: a role key that exists in Zitadel and not here is
// dropped at the boundary, and a principal holding only unknown roles is
// refused with an error that logs the raw values.
func TestCapabilitiesMatchTheTypeScriptVocabulary(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "packages", "platform-auth", "src", "capabilities.ts")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the TypeScript vocabulary: %v", err)
	}

	got := parseTSCapabilities(t, string(source))

	if len(got) != len(Capabilities) {
		t.Fatalf("capability count differs — ts has %d %v, go has %d %v",
			len(got), got, len(Capabilities), Capabilities)
	}
	// ORDER matters as well as membership. capabilities.ts declares entry,
	// then surfaces, then verbs, and its own test pins that order against the
	// Zitadel role list — so a reordering here would mean one of the two files
	// had been edited without the other.
	for i, want := range got {
		if string(Capabilities[i]) != want {
			t.Errorf("position %d: ts has %q, go has %q", i, want, Capabilities[i])
		}
	}
}

// parseTSCapabilities pulls the quoted entries out of the CAPABILITIES array.
//
// Deliberately naive — it reads one array literal, not TypeScript. If
// capabilities.ts ever becomes clever enough to defeat this, that is itself
// worth knowing: a vocabulary assembled at runtime could not be checked against
// Zitadel's static role list either.
func parseTSCapabilities(t *testing.T, source string) []string {
	t.Helper()

	start := regexp.MustCompile(`export const CAPABILITIES\s*=\s*\[`).FindStringIndex(source)
	if start == nil {
		t.Fatal("could not find `export const CAPABILITIES = [` — has capabilities.ts been restructured?")
	}
	rest := source[start[1]:]
	end := regexp.MustCompile(`\n\]\s*as const`).FindStringIndex(rest)
	if end == nil {
		t.Fatal("could not find the end of the CAPABILITIES array")
	}
	body := rest[:end[0]]

	// Strip comments first: the block is heavily documented and several
	// comments quote capability names, which would otherwise be read as
	// entries.
	body = regexp.MustCompile(`(?s)/\*.*?\*/`).ReplaceAllString(body, "")
	body = regexp.MustCompile(`(?m)//.*$`).ReplaceAllString(body, "")

	var out []string
	for _, m := range regexp.MustCompile(`"([a-z-]+)"`).FindAllStringSubmatch(body, -1) {
		out = append(out, m[1])
	}
	if len(out) == 0 {
		t.Fatal("parsed no capabilities from capabilities.ts — the parser is broken, not the vocabulary")
	}
	return out
}

// Guards the parser itself. A parser that silently returns the wrong list would
// make the contract test above pass for the wrong reason.
func TestTheTypeScriptParserIgnoresComments(t *testing.T) {
	source := `
export const CAPABILITIES = [
  /** Entry ticket. Mentions "crm" and "hard-delete" in prose. */
  "read",
  // A line comment naming "support" should not be read as an entry.
  "crm",
] as const;
`
	got := parseTSCapabilities(t, source)

	want := []string{"read", "crm"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("want %v, got %v", want, got)
		}
	}
}

// The surface/verb split must hold on this side too, and every capability must
// be accounted for — an unclassified one is one nobody has decided the shape of.
func TestEveryCapabilityIsEntryOrSurfaceOrVerb(t *testing.T) {
	seen := map[Capability]int{CapRead: 1}
	for _, c := range Surfaces {
		seen[c]++
	}
	for _, c := range Verbs {
		seen[c]++
	}

	for _, c := range Capabilities {
		switch seen[c] {
		case 0:
			t.Errorf("%q is in neither the entry, surface nor verb bucket", c)
		case 1: // exactly one bucket, as it should be
		default:
			t.Errorf("%q appears in more than one bucket — surfaces and verbs must be disjoint", c)
		}
	}
}
