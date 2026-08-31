package auth_test

import (
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
)

func TestAllowlistPermitsListedAddress(t *testing.T) {
	a := auth.NewAllowlist([]string{"samyak.rout@gmail.com", "mahesh.sangawar@gmail.com"})

	if !a.Permits("samyak.rout@gmail.com") {
		t.Fatal("listed address was denied")
	}
	if !a.Permits("mahesh.sangawar@gmail.com") {
		t.Fatal("second listed address was denied")
	}
}

func TestAllowlistDeniesUnlistedAddress(t *testing.T) {
	a := auth.NewAllowlist([]string{"samyak.rout@gmail.com"})

	for _, email := range []string{
		"mallory@gmail.com",
		"samyak.rout@gmail.com.evil.example",
		"evil.example/samyak.rout@gmail.com",
		"",
	} {
		if a.Permits(email) {
			t.Errorf("unlisted address %q was permitted", email)
		}
	}
}

// Keycloak may return the address in any case; the allowlist is an identity
// check, not a string match.
func TestAllowlistIsCaseAndSpaceInsensitive(t *testing.T) {
	a := auth.NewAllowlist([]string{"  Samyak.Rout@Gmail.com  "})

	if !a.Permits("SAMYAK.ROUT@GMAIL.COM") {
		t.Fatal("uppercase form of a listed address was denied")
	}
	if !a.Permits(" samyak.rout@gmail.com\t") {
		t.Fatal("padded form of a listed address was denied")
	}
}

// An empty allowlist must lock everyone out rather than let everyone in.
func TestEmptyAllowlistDeniesEveryone(t *testing.T) {
	for _, entries := range [][]string{nil, {}, {"", "   "}} {
		a := auth.NewAllowlist(entries)
		if a.Permits("samyak.rout@gmail.com") {
			t.Errorf("allowlist built from %q permitted an address", entries)
		}
		if a.Size() != 0 {
			t.Errorf("allowlist built from %q reported size %d, want 0", entries, a.Size())
		}
	}
}

func TestAllowlistDeduplicates(t *testing.T) {
	a := auth.NewAllowlist([]string{"a@b.com", "A@B.com", "c@d.com"})

	if a.Size() != 2 {
		t.Fatalf("Size() = %d, want 2", a.Size())
	}
}
