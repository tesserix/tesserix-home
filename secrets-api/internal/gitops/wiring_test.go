package gitops_test

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

const chartValues = `# The tunnel connector.
replicaCount: 2

externalSecrets:
  enabled: true
  # Where the tunnel token is read from.
  secretStore: gcp-secret-store
  secretStoreKind: ClusterSecretStore
  remoteKey: prod-cloudflared-tunnel-token

resources:
  limits:
    memory: 128Mi
`

func wiring() gitops.Wiring {
	return gitops.Wiring{App: "cloudflared", RemoteKey: "cloudflared/cloudflared/tunnel", RemoteProperty: "token"}
}

func TestRewirePointsTheChartAtTheAppsOwnStore(t *testing.T) {
	got, err := gitops.Rewire(chartValues, wiring())
	if err != nil {
		t.Fatalf("Rewire: %v", err)
	}

	for _, want := range []string{
		"secretStore: openbao-cloudflared",
		"secretStoreKind: SecretStore",
		"remoteKey: cloudflared/cloudflared/tunnel",
		"remoteProperty: token",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rewired values do not contain %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "gcp-secret-store") {
		t.Errorf("rewired values still read from Secret Manager:\n%s", got)
	}
}

func TestRewireKeepsTheRestOfTheChartValues(t *testing.T) {
	got, err := gitops.Rewire(chartValues, wiring())
	if err != nil {
		t.Fatalf("Rewire: %v", err)
	}

	if !strings.HasPrefix(got, "# The tunnel connector.\nreplicaCount: 2\n\nexternalSecrets:\n") {
		t.Errorf("content before the block changed:\n%s", got)
	}
	if !strings.HasSuffix(got, "\n\nresources:\n  limits:\n    memory: 128Mi\n") {
		t.Errorf("content after the block changed, blank line included:\n%s", got)
	}
	if !strings.Contains(got, "# Where the tunnel token is read from.") {
		t.Errorf("comment was lost:\n%s", got)
	}
	if !strings.Contains(got, "enabled: true") {
		t.Errorf("an unrelated key in the block was dropped:\n%s", got)
	}
}

func TestRewireIsIdempotent(t *testing.T) {
	once, err := gitops.Rewire(chartValues, wiring())
	if err != nil {
		t.Fatalf("Rewire: %v", err)
	}
	twice, err := gitops.Rewire(once, wiring())
	if err != nil {
		t.Fatalf("Rewire: %v", err)
	}
	if twice != once {
		t.Errorf("rewiring an already-rewired chart changed it again:\n%s", twice)
	}
}

// A chart that does not spell its ExternalSecret in values has to be wired by
// hand; guessing at it would open a pull request that renders nothing.
func TestRewireRefusesAChartWithoutTheContract(t *testing.T) {
	for name, values := range map[string]string{
		"no block": "replicaCount: 2\n",
		"no keys":  "externalSecrets:\n  enabled: true\n",
	} {
		if _, err := gitops.Rewire(values, wiring()); err == nil {
			t.Errorf("Rewire succeeded on a chart with %s, want an error", name)
		}
	}
}

func TestRewireRejectsAnInvalidApp(t *testing.T) {
	w := wiring()
	w.App = "../etc"
	if _, err := gitops.Rewire(chartValues, w); err == nil {
		t.Error("Rewire accepted an invalid app name, want an error")
	}
}

func TestBumpChartVersionRaisesThePatch(t *testing.T) {
	chart := "apiVersion: v2\nname: cloudflared\nversion: 1.1.9\nappVersion: \"2024.1.0\"\n"

	got, err := gitops.BumpChartVersion(chart)
	if err != nil {
		t.Fatalf("BumpChartVersion: %v", err)
	}
	if !strings.Contains(got, "version: 1.1.10") {
		t.Errorf("version was not bumped:\n%s", got)
	}
	// appVersion is the image tag, not the chart's own version.
	if !strings.Contains(got, "appVersion: \"2024.1.0\"") {
		t.Errorf("appVersion was rewritten:\n%s", got)
	}
}

func TestBumpChartVersionReportsAVersionItCannotParse(t *testing.T) {
	if _, err := gitops.BumpChartVersion("apiVersion: v2\nname: cloudflared\n"); err == nil {
		t.Error("BumpChartVersion succeeded on a Chart.yaml with no version, want an error")
	}
}

func wiringRequest() gitops.WiringRequest {
	return gitops.WiringRequest{
		Namespace:  "cloudflared",
		ChartPath:  "charts/infrastructure/cloudflared",
		ValuesFile: "values.yaml",
		Wiring:     wiring(),
		Actor:      "samyak.rout@gmail.com",
	}
}

func TestProposeWiringCommitsTheValuesAndTheChartVersion(t *testing.T) {
	client, seen := stubGitHub(t, chartRoutes(t))

	url, err := client.ProposeWiring(context.Background(), wiringRequest())
	if err != nil {
		t.Fatalf("ProposeWiring: %v", err)
	}
	if url != "https://github.com/tesserix/tesserix-k8s/pull/9" {
		t.Errorf("ProposeWiring returned %q, want the pull request URL", url)
	}

	values := findCall(t, *seen, http.MethodPut, "cloudflared/values.yaml")
	decoded, _ := base64.StdEncoding.DecodeString(values.Body["content"].(string))
	if !strings.Contains(string(decoded), "secretStore: openbao-cloudflared") {
		t.Errorf("committed values do not read from OpenBao:\n%s", decoded)
	}
	if values.Body["branch"] == "main" {
		t.Fatal("ProposeWiring committed straight to main")
	}

	// ArgoCD syncs on the chart version; without the bump the values change
	// merges and never reaches the cluster.
	chart := findCall(t, *seen, http.MethodPut, "Chart.yaml")
	decoded, _ = base64.StdEncoding.DecodeString(chart.Body["content"].(string))
	if !strings.Contains(string(decoded), "version: 1.1.10") {
		t.Errorf("chart version was not bumped:\n%s", decoded)
	}
	if chart.Body["branch"] != values.Body["branch"] {
		t.Error("the two commits landed on different branches, so one review cannot cover both")
	}
}

func TestProposeWiringBodyCarriesRequesterTrailer(t *testing.T) {
	client, seen := stubGitHub(t, chartRoutes(t))

	req := wiringRequest()
	req.Actor = "subject-7"
	if _, err := client.ProposeWiring(context.Background(), req); err != nil {
		t.Fatalf("ProposeWiring: %v", err)
	}

	body, _ := findCall(t, *seen, http.MethodPost, "/pulls").Body["body"].(string)
	if !strings.Contains(body, "requested-by: subject-7") {
		t.Fatalf("body missing requester trailer:\n%s", body)
	}
}

func TestProposeWiringRefusesAPathOutsideTheCharts(t *testing.T) {
	client, seen := stubGitHub(t, chartRoutes(t))

	for name, path := range map[string]string{
		"traversal": "charts/../.github/workflows",
		"elsewhere": "argocd/prod/apps/global",
	} {
		req := wiringRequest()
		req.ChartPath = path
		if _, err := client.ProposeWiring(context.Background(), req); err == nil {
			t.Errorf("ProposeWiring accepted a %s chart path", name)
		}
	}
	if len(*seen) > 0 {
		t.Errorf("a rejected path still called GitHub: %+v", *seen)
	}
}

func TestProposeWiringRefusesAValuesFileThatIsNotOne(t *testing.T) {
	client, _ := stubGitHub(t, chartRoutes(t))

	req := wiringRequest()
	req.ValuesFile = "../../.github/workflows/ci.yml"
	if _, err := client.ProposeWiring(context.Background(), req); err == nil {
		t.Error("ProposeWiring accepted a file that is not a values file")
	}
}
