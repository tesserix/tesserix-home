package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var (
	ErrInvalidSession = errors.New("auth: session token is not valid")
	ErrSessionExpired = errors.New("auth: session has expired")
)

// SealerKeySize is the required length of the session encryption key.
const SealerKeySize = 32

type Session struct {
	Subject   string    `json:"sub"`
	Email     string    `json:"email"`
	Name      string    `json:"name,omitempty"`
	ExpiresAt time.Time `json:"exp"`
}

// Sealer turns a Session into an opaque cookie value and back. The cookie is
// encrypted rather than merely signed so that a stolen cookie reveals nothing
// about who holds it.
type Sealer struct {
	aead cipher.AEAD
	now  func() time.Time
}

func NewSealer(key []byte) (*Sealer, error) {
	if len(key) != SealerKeySize {
		return nil, fmt.Errorf("auth: session key must be %d bytes, got %d", SealerKeySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("auth: new cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("auth: new gcm: %w", err)
	}
	return &Sealer{aead: aead, now: time.Now}, nil
}

// purposeSession and purposeLogin are bound in as GCM additional data so a
// cookie minted for one flow cannot be replayed into the other.
const (
	purposeSession = "session"
	purposeLogin   = "login"
)

func (s *Sealer) Seal(sess Session) (string, error) {
	return s.seal(purposeSession, sess)
}

func (s *Sealer) Open(token string) (Session, error) {
	var sess Session
	if err := s.open(purposeSession, token, &sess); err != nil {
		return Session{}, err
	}
	if !sess.ExpiresAt.After(s.now()) {
		return Session{}, ErrSessionExpired
	}
	return sess, nil
}

func (s *Sealer) seal(purpose string, v any) (string, error) {
	payload, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("auth: marshal %s: %w", purpose, err)
	}

	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("auth: read nonce: %w", err)
	}

	sealed := s.aead.Seal(nonce, nonce, payload, []byte(purpose))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (s *Sealer) open(purpose, token string, dst any) error {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) < s.aead.NonceSize() {
		return ErrInvalidSession
	}

	nonce, ciphertext := raw[:s.aead.NonceSize()], raw[s.aead.NonceSize():]
	payload, err := s.aead.Open(nil, nonce, ciphertext, []byte(purpose))
	if err != nil {
		return ErrInvalidSession
	}
	if err := json.Unmarshal(payload, dst); err != nil {
		return ErrInvalidSession
	}
	return nil
}
