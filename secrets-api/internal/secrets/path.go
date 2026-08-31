package secrets

import (
	"fmt"
	"regexp"
	"strings"
)

const maxSecretPathLen = 512

var namespacePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// CleanSecretPath normalises a KV path and refuses anything that could escape
// the prefix the caller was authorised against.
func CleanSecretPath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if len(p) > maxSecretPathLen {
		return "", fmt.Errorf("secrets: path exceeds %d characters", maxSecretPathLen)
	}
	if strings.ContainsRune(p, '\\') {
		return "", fmt.Errorf("secrets: path may not contain a backslash")
	}

	segments := make([]string, 0, 8)
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "":
			continue
		case ".", "..":
			return "", fmt.Errorf("secrets: path may not contain %q", seg)
		}
		if err := validateSegment(seg); err != nil {
			return "", err
		}
		segments = append(segments, seg)
	}
	if len(segments) == 0 {
		return "", fmt.Errorf("secrets: path is empty")
	}
	return strings.Join(segments, "/"), nil
}

func validateSegment(seg string) error {
	// Percent-encoding is never legitimate here and is the usual way a traversal
	// is smuggled past a naive split.
	if strings.Contains(seg, "%") {
		return fmt.Errorf("secrets: path segment %q may not be percent-encoded", seg)
	}
	for _, r := range seg {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("secrets: path segment contains a control character")
		}
	}
	return nil
}

// SecretRef is a secret's address. The first two segments are the isolation
// boundary: the OpenBao policy an app receives is scoped to
// kv/data/<namespace>/<app>/*, so a secret that does not name both cannot be
// reached by anything and would sit in the store unreadable.
type SecretRef struct {
	Namespace string `json:"namespace"`
	App       string `json:"app"`
	Name      string `json:"name"`
}

func (r SecretRef) Path() string { return r.Namespace + "/" + r.App + "/" + r.Name }

// Prefix is the policy prefix that isolates this secret's owning app.
func (r SecretRef) Prefix() string { return r.Namespace + "/" + r.App }

func ParseSecretRef(p string) (SecretRef, error) {
	clean, err := CleanSecretPath(p)
	if err != nil {
		return SecretRef{}, err
	}

	segments := strings.Split(clean, "/")
	if len(segments) < 3 {
		return SecretRef{}, fmt.Errorf("secrets: %q must be <namespace>/<app>/<name>", clean)
	}
	if err := ValidateNamespace(segments[0]); err != nil {
		return SecretRef{}, err
	}
	if !namespacePattern.MatchString(segments[1]) {
		return SecretRef{}, fmt.Errorf("secrets: %q is not a valid app name", segments[1])
	}

	return SecretRef{
		Namespace: segments[0],
		App:       segments[1],
		Name:      strings.Join(segments[2:], "/"),
	}, nil
}

// IsDNSLabel reports whether a name is a valid Kubernetes object name — the
// shape a namespace, app, or service account must have.
func IsDNSLabel(name string) bool { return namespacePattern.MatchString(name) }

func ValidateNamespace(ns string) error {
	if !namespacePattern.MatchString(ns) {
		return fmt.Errorf("secrets: %q is not a valid Kubernetes namespace name", ns)
	}
	return nil
}
