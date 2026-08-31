package gitops_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

const projectYAML = `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: security
spec:
  destinations:
    - namespace: openbao
      server: https://kubernetes.default.svc
    # Keep this list equal to namespaceWhitelist.
    - namespace: homechef
      server: https://kubernetes.default.svc

  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
`

func TestAddDestinationAppendsANamespace(t *testing.T) {
	got, err := gitops.AddDestination(projectYAML, "cloudflared")
	if err != nil {
		t.Fatalf("AddDestination: %v", err)
	}

	if !strings.Contains(got, "- namespace: cloudflared\n      server: https://kubernetes.default.svc") {
		t.Errorf("destination was not added in the expected shape:\n%s", got)
	}
}

func TestAddDestinationIsIdempotent(t *testing.T) {
	got, err := gitops.AddDestination(projectYAML, "homechef")
	if err != nil {
		t.Fatalf("AddDestination: %v", err)
	}

	if strings.Count(got, "namespace: homechef") != 1 {
		t.Errorf("existing destination was duplicated:\n%s", got)
	}
}

func TestAddDestinationKeepsCommentsAndBlankLines(t *testing.T) {
	got, err := gitops.AddDestination(projectYAML, "cloudflared")
	if err != nil {
		t.Fatalf("AddDestination: %v", err)
	}

	if !strings.Contains(got, "# Keep this list equal to namespaceWhitelist.") {
		t.Errorf("comment was lost:\n%s", got)
	}
	if !strings.HasSuffix(got, "\n\n  clusterResourceWhitelist:\n    - group: \"\"\n      kind: Namespace\n") {
		t.Errorf("content after the destinations block changed:\n%s", got)
	}
}

func TestRemoveDestinationDropsOnlyThatNamespace(t *testing.T) {
	got, err := gitops.RemoveDestination(projectYAML, "homechef")
	if err != nil {
		t.Fatalf("RemoveDestination: %v", err)
	}

	if strings.Contains(got, "namespace: homechef") {
		t.Errorf("destination was not removed:\n%s", got)
	}
	if !strings.Contains(got, "namespace: openbao") {
		t.Errorf("removing one destination dropped another:\n%s", got)
	}
}

func TestAddDestinationRejectsAnInvalidNamespace(t *testing.T) {
	if _, err := gitops.AddDestination(projectYAML, "../etc"); err == nil {
		t.Error("AddDestination succeeded on an invalid namespace, want error")
	}
}
