// Package gitops edits the namespace whitelist in tesserix-k8s. Nothing here
// touches a cluster: a change becomes real only once the pull request it opens
// is merged and ArgoCD syncs it.
package gitops

import (
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

const whitelistKey = "namespaceWhitelist"

var dnsLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// App is one entry of the whitelist: the app that may read from OpenBao and the
// ServiceAccount it authenticates as.
type App struct {
	Namespace      string `json:"namespace"`
	Name           string `json:"name"`
	ServiceAccount string `json:"serviceAccount"`
}

func (a App) validate() error {
	for field, value := range map[string]string{
		"namespace":      a.Namespace,
		"name":           a.Name,
		"serviceAccount": a.ServiceAccount,
	} {
		if !dnsLabel.MatchString(value) {
			return fmt.Errorf("gitops: %s %q is not a valid Kubernetes name", field, value)
		}
	}
	return nil
}

// AddApp returns values.yaml with the app present, adding its namespace if it
// is not listed yet. It is idempotent.
func AddApp(values string, app App) (string, error) {
	if err := app.validate(); err != nil {
		return "", err
	}

	return edit(values, func(list *yaml.Node) error {
		entry := findNamespace(list, app.Namespace)
		if entry == nil {
			list.Content = append(list.Content, namespaceNode(app))
			return nil
		}

		apps := field(entry, "apps")
		if apps == nil {
			return fmt.Errorf("gitops: namespace %q has no apps list", app.Namespace)
		}
		for _, existing := range apps.Content {
			if scalar(field(existing, "name")) == app.Name {
				return nil
			}
		}
		apps.Content = append(apps.Content, appNode(app))
		return nil
	})
}

// RemoveApp drops an app, and the namespace with it if that was its last.
func RemoveApp(values, namespace, name string) (string, error) {
	return edit(values, func(list *yaml.Node) error {
		entry := findNamespace(list, namespace)
		if entry == nil {
			return nil
		}

		apps := field(entry, "apps")
		if apps != nil {
			kept := make([]*yaml.Node, 0, len(apps.Content))
			for _, existing := range apps.Content {
				if scalar(field(existing, "name")) != name {
					kept = append(kept, existing)
				}
			}
			apps.Content = kept
		}

		if apps == nil || len(apps.Content) == 0 {
			kept := make([]*yaml.Node, 0, len(list.Content))
			for _, candidate := range list.Content {
				if candidate != entry {
					kept = append(kept, candidate)
				}
			}
			list.Content = kept
		}
		return nil
	})
}

// HasNamespace reports whether any app in the namespace is still whitelisted.
func HasNamespace(values, namespace string) bool {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(values), &doc); err != nil || len(doc.Content) == 0 {
		return false
	}
	list := field(doc.Content[0], whitelistKey)
	if list == nil {
		return false
	}
	entry := findNamespace(list, namespace)
	apps := field(entry, "apps")
	return apps != nil && len(apps.Content) > 0
}

// edit round-trips through yaml.Node rather than a struct so that the comments
// carrying the reason for each entry survive the change. Only the whitelist
// block is re-rendered and spliced back in: yaml.v3 keeps comments but drops
// every blank line, so re-emitting the whole document buried a three-line grant
// in a fifty-line diff.
func edit(values string, mutate func(*yaml.Node) error) (string, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(values), &doc); err != nil {
		return "", fmt.Errorf("gitops: parse values.yaml: %w", err)
	}
	if len(doc.Content) == 0 {
		return "", fmt.Errorf("gitops: values.yaml is empty")
	}

	list := field(doc.Content[0], whitelistKey)
	if list == nil {
		return "", fmt.Errorf("gitops: values.yaml has no %s", whitelistKey)
	}
	if err := mutate(list); err != nil {
		return "", err
	}

	// Anything that rendered above the key line is in the untouched prefix;
	// re-emitting it here would duplicate it.
	list.HeadComment = ""
	block, err := marshal(list)
	if err != nil {
		return "", fmt.Errorf("gitops: render %s: %w", whitelistKey, err)
	}

	return splice(values, whitelistKey, block)
}

// splice replaces one key's block with the freshly rendered one, leaving every
// other byte of the file alone.
func splice(text, key, block string) (string, error) {
	lines := strings.Split(text, "\n")

	start, indent := -1, ""
	for i, line := range lines {
		if strings.TrimSpace(line) == key+":" {
			start = i
			indent = line[:len(line)-len(strings.TrimLeft(line, " \t"))]
			break
		}
	}
	if start < 0 {
		return "", fmt.Errorf("gitops: no %s line to replace", key)
	}

	// The block runs to the last line indented past the key. Trailing blank
	// lines and any comment banner introducing the next section stay put.
	end := start
	for i := start + 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		lead := lines[i][:len(lines[i])-len(strings.TrimLeft(lines[i], " \t"))]
		if len(lead) <= len(indent) {
			break
		}
		end = i
	}

	rendered := []string{indent + key + ":"}
	for _, line := range strings.Split(strings.TrimRight(block, "\n"), "\n") {
		rendered = append(rendered, indent+"  "+line)
	}

	out := append([]string{}, lines[:start]...)
	out = append(out, rendered...)
	out = append(out, lines[end+1:]...)
	return strings.Join(out, "\n"), nil
}

func findNamespace(list *yaml.Node, namespace string) *yaml.Node {
	for _, entry := range list.Content {
		if scalar(field(entry, "namespace")) == namespace {
			return entry
		}
	}
	return nil
}

func field(mapping *yaml.Node, key string) *yaml.Node {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1]
		}
	}
	return nil
}

func scalar(n *yaml.Node) string {
	if n == nil {
		return ""
	}
	return n.Value
}

func namespaceNode(app App) *yaml.Node {
	return &yaml.Node{
		Kind: yaml.MappingNode,
		Content: []*yaml.Node{
			str("namespace"), str(app.Namespace),
			str("apps"), {Kind: yaml.SequenceNode, Content: []*yaml.Node{appNode(app)}},
		},
	}
}

func appNode(app App) *yaml.Node {
	return &yaml.Node{
		Kind: yaml.MappingNode,
		Content: []*yaml.Node{
			str("name"), str(app.Name),
			str("serviceAccount"), str(app.ServiceAccount),
		},
	}
}

func str(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}
