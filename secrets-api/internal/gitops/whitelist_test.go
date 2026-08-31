package gitops_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

const valuesYAML = `# The whitelist.
namespaceWhitelist:
  - namespace: homechef
    apps:
      # The API reads its database password here.
      - name: homechef-api
        serviceAccount: homechef-api
  - namespace: ai-database
    apps:
      - name: qdrant
        serviceAccount: qdrant

clusterSecretStore:
  enabled: true
`

func TestAddAppAppendsToAnExistingNamespace(t *testing.T) {
	got, err := gitops.AddApp(valuesYAML, gitops.App{Namespace: "homechef", Name: "homechef-worker", ServiceAccount: "homechef-worker"})
	if err != nil {
		t.Fatalf("AddApp: %v", err)
	}

	if !strings.Contains(got, "homechef-worker") {
		t.Errorf("result does not contain the new app:\n%s", got)
	}
	if strings.Count(got, "namespace: homechef") != 1 {
		t.Errorf("namespace was duplicated instead of appended to:\n%s", got)
	}
}

// values.yaml is mostly comments explaining why each entry exists; a round-trip
// that drops them would make every proposed change unreviewable.
func TestAddAppKeepsComments(t *testing.T) {
	got, err := gitops.AddApp(valuesYAML, gitops.App{Namespace: "homechef", Name: "homechef-worker", ServiceAccount: "homechef-worker"})
	if err != nil {
		t.Fatalf("AddApp: %v", err)
	}

	for _, comment := range []string{"# The whitelist.", "# The API reads its database password here."} {
		if !strings.Contains(got, comment) {
			t.Errorf("comment %q was lost:\n%s", comment, got)
		}
	}
}

// A yaml.v3 round-trip keeps comments but drops every blank line, which turned
// three-line grants into ~57-line diffs nobody could review. Everything outside
// the whitelist block must come back untouched.
func TestAddAppKeepsTheRestOfTheFileByteForByte(t *testing.T) {
	got, err := gitops.AddApp(valuesYAML, gitops.App{Namespace: "homechef", Name: "homechef-worker", ServiceAccount: "homechef-worker"})
	if err != nil {
		t.Fatalf("AddApp: %v", err)
	}

	prefix := "# The whitelist.\nnamespaceWhitelist:\n"
	if !strings.HasPrefix(got, prefix) {
		t.Errorf("content before the whitelist changed:\n%s", got)
	}
	suffix := "\n\nclusterSecretStore:\n  enabled: true\n"
	if !strings.HasSuffix(got, suffix) {
		t.Errorf("content after the whitelist changed, blank line included:\n%s", got)
	}
}

func TestAddAppCreatesAnAbsentNamespace(t *testing.T) {
	got, err := gitops.AddApp(valuesYAML, gitops.App{Namespace: "fanzone", Name: "fanzone-api", ServiceAccount: "fanzone-api"})
	if err != nil {
		t.Fatalf("AddApp: %v", err)
	}

	if !strings.Contains(got, "namespace: fanzone") || !strings.Contains(got, "fanzone-api") {
		t.Errorf("new namespace was not added:\n%s", got)
	}
}

func TestAddAppIsIdempotent(t *testing.T) {
	app := gitops.App{Namespace: "ai-database", Name: "qdrant", ServiceAccount: "qdrant"}

	got, err := gitops.AddApp(valuesYAML, app)
	if err != nil {
		t.Fatalf("AddApp: %v", err)
	}
	if strings.Count(got, "name: qdrant") != 1 {
		t.Errorf("re-adding an existing app duplicated it:\n%s", got)
	}
}

func TestRemoveAppDropsOnlyThatApp(t *testing.T) {
	got, err := gitops.RemoveApp(valuesYAML, "homechef", "homechef-api")
	if err != nil {
		t.Fatalf("RemoveApp: %v", err)
	}

	if strings.Contains(got, "homechef-api") {
		t.Errorf("app was not removed:\n%s", got)
	}
	if !strings.Contains(got, "name: qdrant") {
		t.Errorf("removing one app dropped another namespace's:\n%s", got)
	}
}

func TestRemoveAppDropsTheNamespaceWhenItsLastAppGoes(t *testing.T) {
	got, err := gitops.RemoveApp(valuesYAML, "ai-database", "qdrant")
	if err != nil {
		t.Fatalf("RemoveApp: %v", err)
	}

	if strings.Contains(got, "ai-database") {
		t.Errorf("empty namespace was left behind:\n%s", got)
	}
}

func TestAddAppRejectsAnInvalidName(t *testing.T) {
	for _, app := range []gitops.App{
		{Namespace: "Homechef", Name: "api", ServiceAccount: "api"},
		{Namespace: "homechef", Name: "../etc", ServiceAccount: "api"},
		{Namespace: "homechef", Name: "api", ServiceAccount: ""},
	} {
		if _, err := gitops.AddApp(valuesYAML, app); err == nil {
			t.Errorf("AddApp(%+v) succeeded, want error", app)
		}
	}
}
