package auth_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
)

func testKey(b byte) []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = b
	}
	return k
}

func newSealer(t *testing.T, key []byte) *auth.Sealer {
	t.Helper()
	s, err := auth.NewSealer(key)
	if err != nil {
		t.Fatalf("NewSealer: %v", err)
	}
	return s
}

func TestSealerRoundTripsSession(t *testing.T) {
	s := newSealer(t, testKey(1))
	want := auth.Session{
		Subject:   "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
		Email:     "samyak.rout@gmail.com",
		Name:      "Samyak Rout",
		ExpiresAt: time.Now().Add(time.Hour).UTC().Truncate(time.Second),
	}

	token, err := s.Seal(want)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	got, err := s.Open(token)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if got.Subject != want.Subject || got.Email != want.Email || got.Name != want.Name {
		t.Fatalf("Open() = %+v, want %+v", got, want)
	}
	if !got.ExpiresAt.Equal(want.ExpiresAt) {
		t.Fatalf("ExpiresAt = %v, want %v", got.ExpiresAt, want.ExpiresAt)
	}
}

// The cookie must be opaque to the browser — the email must not be readable
// from the token without the key.
func TestSealedTokenDoesNotLeakClaims(t *testing.T) {
	s := newSealer(t, testKey(1))

	token, err := s.Seal(auth.Session{Email: "samyak.rout@gmail.com", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	if strings.Contains(token, "samyak") || strings.Contains(token, "gmail") {
		t.Fatalf("token leaks claims in plaintext: %q", token)
	}
}

func TestOpenRejectsTamperedToken(t *testing.T) {
	s := newSealer(t, testKey(1))
	token, err := s.Seal(auth.Session{Email: "samyak.rout@gmail.com", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	tampered := []byte(token)
	tampered[len(tampered)-2] ^= 0x01

	if _, err := s.Open(string(tampered)); !errors.Is(err, auth.ErrInvalidSession) {
		t.Fatalf("Open(tampered) error = %v, want ErrInvalidSession", err)
	}
}

func TestOpenRejectsTokenFromAnotherKey(t *testing.T) {
	token, err := newSealer(t, testKey(1)).Seal(auth.Session{
		Email:     "samyak.rout@gmail.com",
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	if _, err := newSealer(t, testKey(2)).Open(token); !errors.Is(err, auth.ErrInvalidSession) {
		t.Fatalf("Open(foreign key) error = %v, want ErrInvalidSession", err)
	}
}

func TestOpenRejectsExpiredSession(t *testing.T) {
	s := newSealer(t, testKey(1))
	token, err := s.Seal(auth.Session{
		Email:     "samyak.rout@gmail.com",
		ExpiresAt: time.Now().Add(-time.Second),
	})
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	if _, err := s.Open(token); !errors.Is(err, auth.ErrSessionExpired) {
		t.Fatalf("Open(expired) error = %v, want ErrSessionExpired", err)
	}
}

func TestOpenRejectsMalformedToken(t *testing.T) {
	s := newSealer(t, testKey(1))

	for _, token := range []string{"", "not-base64!!", "c2hvcnQ="} {
		if _, err := s.Open(token); !errors.Is(err, auth.ErrInvalidSession) {
			t.Errorf("Open(%q) error = %v, want ErrInvalidSession", token, err)
		}
	}
}

func TestSealUsesAFreshNonceEachTime(t *testing.T) {
	s := newSealer(t, testKey(1))
	sess := auth.Session{Email: "samyak.rout@gmail.com", ExpiresAt: time.Now().Add(time.Hour)}

	first, err := s.Seal(sess)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	second, err := s.Seal(sess)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	if first == second {
		t.Fatal("two seals of the same session produced an identical token")
	}
}

func TestNewSealerRejectsUndersizedKey(t *testing.T) {
	for _, size := range []int{0, 16, 31} {
		if _, err := auth.NewSealer(make([]byte, size)); err == nil {
			t.Errorf("NewSealer(%d-byte key) succeeded, want error", size)
		}
	}
}
