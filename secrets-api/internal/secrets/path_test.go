package secrets_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

func TestCleanSecretPathNormalisesSlashes(t *testing.T) {
	cases := map[string]string{
		"homechef/api/db":   "homechef/api/db",
		"/homechef/api/db":  "homechef/api/db",
		"homechef/api/db/":  "homechef/api/db",
		"//homechef//api//": "homechef/api",
		"  homechef/api  ":  "homechef/api",
	}

	for in, want := range cases {
		got, err := secrets.CleanSecretPath(in)
		if err != nil {
			t.Errorf("CleanSecretPath(%q) unexpected error: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("CleanSecretPath(%q) = %q, want %q", in, got, want)
		}
	}
}

// A traversal segment would let an operator reach outside the prefix their
// request was authorised against.
func TestCleanSecretPathRejectsTraversal(t *testing.T) {
	for _, in := range []string{
		"..",
		"../platform/root",
		"homechef/../platform",
		"homechef/./api",
		"homechef/%2e%2e/platform",
		"homechef/api\\db",
	} {
		if got, err := secrets.CleanSecretPath(in); err == nil {
			t.Errorf("CleanSecretPath(%q) = %q, want error", in, got)
		}
	}
}

func TestCleanSecretPathRejectsEmptyAndControlCharacters(t *testing.T) {
	for _, in := range []string{"", "   ", "/", "///", "homechef/\x00api", "homechef/a\nb"} {
		if got, err := secrets.CleanSecretPath(in); err == nil {
			t.Errorf("CleanSecretPath(%q) = %q, want error", in, got)
		}
	}
}

func TestCleanSecretPathRejectsOverlongPath(t *testing.T) {
	if _, err := secrets.CleanSecretPath(strings.Repeat("a", 513)); err == nil {
		t.Fatal("CleanSecretPath(513 chars) succeeded, want error")
	}
}

func TestValidateNamespaceAcceptsRFC1123Labels(t *testing.T) {
	for _, ns := range []string{"homechef", "ai-database", "a", "ns-1"} {
		if err := secrets.ValidateNamespace(ns); err != nil {
			t.Errorf("ValidateNamespace(%q) = %v, want nil", ns, err)
		}
	}
}

func TestValidateNamespaceRejectsInvalidLabels(t *testing.T) {
	for _, ns := range []string{
		"",
		"-leading",
		"trailing-",
		"Upper",
		"under_score",
		"with/slash",
		"a b",
		strings.Repeat("a", 64),
	} {
		if err := secrets.ValidateNamespace(ns); err == nil {
			t.Errorf("ValidateNamespace(%q) = nil, want error", ns)
		}
	}
}

func TestParseSecretRefSplitsNamespaceAppAndName(t *testing.T) {
	ref, err := secrets.ParseSecretRef("/homechef/homechef-api/db")
	if err != nil {
		t.Fatalf("ParseSecretRef: %v", err)
	}

	if ref.Namespace != "homechef" || ref.App != "homechef-api" || ref.Name != "db" {
		t.Fatalf("ParseSecretRef = %+v, want homechef/homechef-api/db", ref)
	}
	if ref.Path() != "homechef/homechef-api/db" {
		t.Fatalf("Path() = %q, want the joined path", ref.Path())
	}
}

// A name may itself be nested; the isolation boundary is the first two segments.
func TestParseSecretRefAllowsANestedName(t *testing.T) {
	ref, err := secrets.ParseSecretRef("marketplace/order-service/providers/razorpay")
	if err != nil {
		t.Fatalf("ParseSecretRef: %v", err)
	}
	if ref.Name != "providers/razorpay" {
		t.Fatalf("Name = %q, want providers/razorpay", ref.Name)
	}
}

// Every secret belongs to exactly one app, because the OpenBao policy that
// isolates it is written against kv/data/<namespace>/<app>/*.
func TestParseSecretRefRejectsPathsShallowerThanAnApp(t *testing.T) {
	for _, p := range []string{"homechef", "homechef/homechef-api", "/", ""} {
		if _, err := secrets.ParseSecretRef(p); err == nil {
			t.Errorf("ParseSecretRef(%q) succeeded, want error", p)
		}
	}
}

func TestParseSecretRefRejectsNamespaceAndAppThatAreNotDNSLabels(t *testing.T) {
	for _, p := range []string{"Homechef/api/db", "homechef/API/db", "homechef/-api/db", "home_chef/api/db"} {
		if _, err := secrets.ParseSecretRef(p); err == nil {
			t.Errorf("ParseSecretRef(%q) succeeded, want error", p)
		}
	}
}

func TestParseSecretRefRejectsTraversal(t *testing.T) {
	for _, p := range []string{"homechef/../platform/db", "homechef/api/../../platform/db"} {
		if _, err := secrets.ParseSecretRef(p); err == nil {
			t.Errorf("ParseSecretRef(%q) succeeded, want error", p)
		}
	}
}
