// Package auth is the estate's Zitadel verifier and capability vocabulary.
//
// It lives in its own module rather than inside platform-api because
// secrets-api needs it too, and Go's internal/ rule forbids importing
// platform-api/internal/... from another module root.
module github.com/tesserix/tesserix-home/platform-auth

go 1.26.5

require github.com/coreos/go-oidc/v3 v3.20.0

require (
	github.com/go-jose/go-jose/v4 v4.1.4 // indirect
	golang.org/x/oauth2 v0.36.0 // indirect
)
