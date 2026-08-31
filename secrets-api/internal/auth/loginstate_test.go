package auth_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
)

func TestLoginStateRoundTrips(t *testing.T) {
	s := newSealer(t, testKey(3))
	want := auth.LoginState{
		State:     "state-123",
		Verifier:  "verifier-abc",
		ReturnTo:  "/secrets/homechef",
		ExpiresAt: time.Now().Add(10 * time.Minute).UTC().Truncate(time.Second),
	}

	token, err := s.SealLoginState(want)
	if err != nil {
		t.Fatalf("SealLoginState: %v", err)
	}
	got, err := s.OpenLoginState(token)
	if err != nil {
		t.Fatalf("OpenLoginState: %v", err)
	}

	if got.State != want.State || got.Verifier != want.Verifier || got.ReturnTo != want.ReturnTo {
		t.Fatalf("OpenLoginState = %+v, want %+v", got, want)
	}
}

// The PKCE verifier must never be readable from the cookie.
func TestSealedLoginStateHidesTheVerifier(t *testing.T) {
	s := newSealer(t, testKey(3))

	token, err := s.SealLoginState(auth.LoginState{
		State:     "state-123",
		Verifier:  "verifier-abc",
		ExpiresAt: time.Now().Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("SealLoginState: %v", err)
	}

	if strings.Contains(token, "verifier-abc") || strings.Contains(token, "state-123") {
		t.Fatalf("login state leaks in plaintext: %q", token)
	}
}

func TestOpenLoginStateRejectsExpiredAndTampered(t *testing.T) {
	s := newSealer(t, testKey(3))

	expired, err := s.SealLoginState(auth.LoginState{State: "s", ExpiresAt: time.Now().Add(-time.Second)})
	if err != nil {
		t.Fatalf("SealLoginState: %v", err)
	}
	if _, err := s.OpenLoginState(expired); !errors.Is(err, auth.ErrSessionExpired) {
		t.Errorf("OpenLoginState(expired) error = %v, want ErrSessionExpired", err)
	}

	valid, err := s.SealLoginState(auth.LoginState{State: "s", ExpiresAt: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatalf("SealLoginState: %v", err)
	}
	tampered := []byte(valid)
	tampered[len(tampered)-2] ^= 0x01
	if _, err := s.OpenLoginState(string(tampered)); !errors.Is(err, auth.ErrInvalidSession) {
		t.Errorf("OpenLoginState(tampered) error = %v, want ErrInvalidSession", err)
	}
}

// A session cookie must not be usable as a login-state cookie or vice versa.
func TestLoginStateAndSessionTokensAreNotInterchangeable(t *testing.T) {
	s := newSealer(t, testKey(3))

	sessionToken, err := s.Seal(auth.Session{Email: "a@b.com", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, err := s.OpenLoginState(sessionToken); err == nil {
		t.Error("a session token opened as login state")
	}

	stateToken, err := s.SealLoginState(auth.LoginState{State: "s", ExpiresAt: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatalf("SealLoginState: %v", err)
	}
	if _, err := s.Open(stateToken); err == nil {
		t.Error("a login-state token opened as a session")
	}
}
