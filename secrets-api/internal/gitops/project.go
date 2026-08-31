package gitops

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

const (
	destinationsKey = "destinations"
	inClusterServer = "https://kubernetes.default.svc"
)

// AddDestination returns the AppProject with the namespace among its
// destinations. Without it ArgoCD refuses to create the SecretStore the
// whitelist entry renders, and reports the app Synced while it does — the one
// step of a grant that fails silently. It is idempotent.
func AddDestination(project, namespace string) (string, error) {
	if !dnsLabel.MatchString(namespace) {
		return "", fmt.Errorf("gitops: namespace %q is not a valid Kubernetes name", namespace)
	}

	return editProject(project, func(list *yaml.Node) error {
		for _, entry := range list.Content {
			if scalar(field(entry, "namespace")) == namespace {
				return nil
			}
		}
		list.Content = append(list.Content, destinationNode(namespace, serverOf(list)))
		return nil
	})
}

// RemoveDestination drops a namespace from the AppProject.
func RemoveDestination(project, namespace string) (string, error) {
	return editProject(project, func(list *yaml.Node) error {
		kept := make([]*yaml.Node, 0, len(list.Content))
		for _, entry := range list.Content {
			if scalar(field(entry, "namespace")) != namespace {
				kept = append(kept, entry)
			}
		}
		list.Content = kept
		return nil
	})
}

func editProject(project string, mutate func(*yaml.Node) error) (string, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(project), &doc); err != nil {
		return "", fmt.Errorf("gitops: parse AppProject: %w", err)
	}
	if len(doc.Content) == 0 {
		return "", fmt.Errorf("gitops: AppProject is empty")
	}

	list := field(field(doc.Content[0], "spec"), destinationsKey)
	if list == nil {
		return "", fmt.Errorf("gitops: AppProject has no spec.%s", destinationsKey)
	}
	if err := mutate(list); err != nil {
		return "", err
	}

	list.HeadComment = ""
	block, err := marshal(list)
	if err != nil {
		return "", fmt.Errorf("gitops: render %s: %w", destinationsKey, err)
	}

	return splice(project, destinationsKey, block)
}

// serverOf follows whatever the existing entries use rather than assuming the
// in-cluster address, so a project pointing at a remote cluster stays consistent.
func serverOf(list *yaml.Node) string {
	for _, entry := range list.Content {
		if server := scalar(field(entry, "server")); server != "" {
			return server
		}
	}
	return inClusterServer
}

func destinationNode(namespace, server string) *yaml.Node {
	return &yaml.Node{
		Kind: yaml.MappingNode,
		Content: []*yaml.Node{
			str("namespace"), str(namespace),
			str("server"), str(server),
		},
	}
}
