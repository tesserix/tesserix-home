package auth_test

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
)

func TestNewPKCEChallengeIsS256OfVerifier(t *testing.T) {
	p, err := auth.NewPKCE()
	if err != nil {
		t.Fatalf("NewPKCE: %v", err)
	}

	sum := sha256.Sum256([]byte(p.Verifier))
	want := base64.RawURLEncoding.EncodeToString(sum[:])

	if p.Challenge != want {
		t.Fatalf("Challenge = %q, want S256(verifier) = %q", p.Challenge, want)
	}
	if p.Method != "S256" {
		t.Fatalf("Method = %q, want S256", p.Method)
	}
}

// RFC 7636 §4.1 requires 43–128 characters of unreserved charset.
func TestNewPKCEVerifierMeetsRFC7636Length(t *testing.T) {
	p, err := auth.NewPKCE()
	if err != nil {
		t.Fatalf("NewPKCE: %v", err)
	}

	if n := len(p.Verifier); n < 43 || n > 128 {
		t.Fatalf("verifier length = %d, want 43..128", n)
	}
}

func TestNewPKCEIsUnpredictable(t *testing.T) {
	seen := make(map[string]struct{}, 32)
	for range 32 {
		p, err := auth.NewPKCE()
		if err != nil {
			t.Fatalf("NewPKCE: %v", err)
		}
		if _, dup := seen[p.Verifier]; dup {
			t.Fatal("NewPKCE repeated a verifier")
		}
		seen[p.Verifier] = struct{}{}
	}
}

func TestRandomTokenIsUnpredictableAndURLSafe(t *testing.T) {
	seen := make(map[string]struct{}, 32)
	for range 32 {
		tok, err := auth.RandomToken(32)
		if err != nil {
			t.Fatalf("RandomToken: %v", err)
		}
		if _, dup := seen[tok]; dup {
			t.Fatal("RandomToken repeated a value")
		}
		if _, err := base64.RawURLEncoding.DecodeString(tok); err != nil {
			t.Fatalf("RandomToken produced a non-URL-safe value %q", tok)
		}
		seen[tok] = struct{}{}
	}
}
