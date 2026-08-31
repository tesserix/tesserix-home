package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

// PKCE carries one authorization-code exchange's proof key (RFC 7636).
type PKCE struct {
	Verifier  string
	Challenge string
	Method    string
}

func NewPKCE() (PKCE, error) {
	verifier, err := RandomToken(48)
	if err != nil {
		return PKCE{}, err
	}
	sum := sha256.Sum256([]byte(verifier))
	return PKCE{
		Verifier:  verifier,
		Challenge: base64.RawURLEncoding.EncodeToString(sum[:]),
		Method:    "S256",
	}, nil
}

// RandomToken returns n bytes of CSPRNG output as an unpadded base64url string.
func RandomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("auth: read random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
