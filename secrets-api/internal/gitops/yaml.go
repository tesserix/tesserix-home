package gitops

import (
	"bytes"

	"gopkg.in/yaml.v3"
)

// marshal renders at two-space indent, matching the charts in tesserix-k8s;
// yaml.v3's default of four would rewrite every untouched line of the file.
func marshal(doc *yaml.Node) (string, error) {
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return "", err
	}
	if err := enc.Close(); err != nil {
		return "", err
	}
	return out.String(), nil
}
