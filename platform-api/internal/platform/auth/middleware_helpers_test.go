package auth

// middleware_test.go used to share its package with verify_test.go, which
// supplied these fixtures. Task 1 moved the verifier and its tests into the
// platform-auth module (they belong there — secrets-api needs them too), and
// _test.go files are never part of an importable package, so nothing outside
// platform-auth can reach verify_test.go's unexported helpers any more.
// middleware.go and middleware_test.go are the frozen refusal-policy layer
// (deliberately not moved — see alias.go), so this file exists only to give
// middleware_test.go back the fixtures it lost, built on the same exported
// alias surface every other caller in this package uses.

import (
	"context"
	"time"
)

const (
	projectID       = "386377618200461939"
	consoleClientID = "386382971877196703"
	// operatorSubject is the `sub` of the operator token the console presents.
	operatorSubject = "386888878927118733"
)

// A parser that returns whatever the test hands it. The signature check is the
// one thing not reimplemented here — that belongs to go-oidc.
type stubParser struct {
	claims *Claims
	err    error
}

func (s stubParser) Parse(context.Context, string) (*Claims, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.claims, nil
}

// Shaped like a JWT so the pre-parse structural check passes. The content is
// irrelevant; the stub decides the claims.
const jwtShaped = "header.payload.signature"

// validClaims is a real OPERATOR access token's shape, roles aside.
func validClaims() *Claims {
	return &Claims{
		Subject:   operatorSubject,
		ClientID:  consoleClientID,
		Audience:  []string{consoleClientID, projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(30 * time.Minute),
		Roles:     []string{"read", "crm"},
	}
}

// verifierFor builds a verifier configured the way a real deployment is —
// with the console's client id known.
func verifierFor(c *Claims) *Verifier {
	return NewVerifier(stubParser{claims: c}, projectID, WithConsoleClientID(consoleClientID))
}
