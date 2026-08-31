package gitops

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const externalSecretsKey = "externalSecrets"

// Wiring points one chart's ExternalSecret at OpenBao. RemoteKey is the path
// the secret was written to, namespace/app/name; RemoteProperty is the key
// within it, empty for a payload read whole.
type Wiring struct {
	App            string
	RemoteKey      string
	RemoteProperty string
}

// Rewire moves a chart's ExternalSecret from Secret Manager to the app's own
// OpenBao store. It edits the four keys charts agree on and refuses a chart
// that does not spell its ExternalSecret in values at all — guessing would open
// a pull request that renders nothing. It is idempotent.
func Rewire(values string, w Wiring) (string, error) {
	if !dnsLabel.MatchString(w.App) {
		return "", fmt.Errorf("gitops: app %q is not a valid Kubernetes name", w.App)
	}
	if strings.TrimSpace(w.RemoteKey) == "" {
		return "", fmt.Errorf("gitops: a rewiring must name the OpenBao path to read")
	}

	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(values), &doc); err != nil {
		return "", fmt.Errorf("gitops: parse chart values: %w", err)
	}
	if len(doc.Content) == 0 {
		return "", fmt.Errorf("gitops: chart values are empty")
	}

	block := field(doc.Content[0], externalSecretsKey)
	if block == nil || block.Kind != yaml.MappingNode {
		return "", fmt.Errorf("gitops: chart values have no %s block; wire this chart by hand", externalSecretsKey)
	}
	for _, key := range []string{"secretStore", "remoteKey"} {
		if field(block, key) == nil {
			return "", fmt.Errorf("gitops: %s has no %s; wire this chart by hand", externalSecretsKey, key)
		}
	}

	set(block, "secretStore", "openbao-"+w.App)
	set(block, "secretStoreKind", "SecretStore")
	set(block, "remoteKey", w.RemoteKey)
	set(block, "remoteProperty", w.RemoteProperty)

	block.HeadComment = ""
	rendered, err := marshal(block)
	if err != nil {
		return "", fmt.Errorf("gitops: render %s: %w", externalSecretsKey, err)
	}
	return splice(values, externalSecretsKey, rendered)
}

// set overwrites a key's value, appending the key when the chart does not carry
// it yet, and leaves any comment on it in place.
func set(mapping *yaml.Node, key, value string) {
	if existing := field(mapping, key); existing != nil {
		existing.Kind = yaml.ScalarNode
		existing.Tag = "!!str"
		existing.Style = 0
		existing.Value = value
		return
	}
	mapping.Content = append(mapping.Content, str(key), str(value))
}

// WiringRequest asks for the pull request that moves one chart onto OpenBao.
type WiringRequest struct {
	Namespace  string
	ChartPath  string
	ValuesFile string
	Wiring
	Actor   string
	Summary string
}

var (
	chartDir   = regexp.MustCompile(`^charts/[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$`)
	valuesFile = regexp.MustCompile(`^values(-[a-z0-9-]+)?\.yaml$`)
)

func (r WiringRequest) validate() error {
	// The token can write anywhere in the repository, so the path a request
	// names is checked against the charts tree rather than trusted.
	if !chartDir.MatchString(r.ChartPath) || strings.Contains(r.ChartPath, "..") {
		return fmt.Errorf("gitops: %q is not a chart directory", r.ChartPath)
	}
	if !valuesFile.MatchString(r.ValuesFile) {
		return fmt.Errorf("gitops: %q is not a chart values file", r.ValuesFile)
	}
	if strings.TrimSpace(r.Actor) == "" {
		return fmt.Errorf("gitops: a rewiring must name the administrator requesting it")
	}
	return nil
}

var chartVersion = regexp.MustCompile(`(?m)^version:\s*(\d+)\.(\d+)\.(\d+)\s*$`)

// BumpChartVersion raises the patch version. ArgoCD syncs on the chart version,
// so a values change that leaves it alone is not picked up.
func BumpChartVersion(chart string) (string, error) {
	match := chartVersion.FindStringSubmatch(chart)
	if match == nil {
		return "", fmt.Errorf("gitops: Chart.yaml has no semver version line to bump")
	}

	patch, err := strconv.Atoi(match[3])
	if err != nil {
		return "", fmt.Errorf("gitops: chart patch version %q is not a number", match[3])
	}
	bumped := fmt.Sprintf("version: %s.%s.%d", match[1], match[2], patch+1)
	return strings.Replace(chart, match[0], bumped, 1), nil
}
