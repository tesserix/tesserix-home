package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// ZitadelRolesClaim is where Zitadel puts project roles.
//
// Shaped as {"read": {"<orgId>": "<orgDomain>"}} — the KEYS are the roles.
// Identical to the claim `packages/platform-auth/src/zitadel.ts` reads, and
// worth restating: it is absent from `claims_supported` in the discovery
// document, so its presence depends on the project asserting roles AND the
// application adding them to the token. When either is off the token verifies
// perfectly and carries nothing, which is what ErrNoRoles exists to name.
const ZitadelRolesClaim = "urn:zitadel:iam:org:project:roles"

// OIDCParser verifies a token's signature against the issuer's JWKS.
//
// go-oidc keeps its own key cache and refetches on an unknown `kid`, so key
// rotation needs no handling here. Building a verifier per request would defeat
// that and hammer the issuer, so one is built at startup and reused.
type OIDCParser struct {
	verifier *oidc.IDTokenVerifier
}

// NewOIDCParser performs issuer discovery once, at startup.
//
// Discovery is a network call, so a failure here means the service does not
// start — deliberately. A service that starts without being able to verify
// tokens can only fail closed on every request, which is a harder outage to
// read than a refusal to boot.
func NewOIDCParser(ctx context.Context, issuer string) (*OIDCParser, error) {
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("zitadel discovery at %s: %w", issuer, err)
	}
	return &OIDCParser{
		verifier: provider.Verifier(&oidc.Config{
			// Audience is checked in Verify, against the PROJECT id rather than
			// a client id — the console requests
			// `urn:zitadel:iam:org:project:id:{projectId}:aud`, so that is what
			// arrives. Letting go-oidc check it too would mean expressing the
			// same rule twice, in two places, with one of them silently
			// authoritative.
			SkipClientIDCheck: true,
			// Expiry is checked in Verify so it can be reported as its own
			// error rather than folded into a generic verification failure.
			SkipExpiryCheck: true,
		}),
	}, nil
}

// Parse verifies the signature and issuer, then extracts the claims this
// service reads.
func (p *OIDCParser) Parse(ctx context.Context, raw string) (*Claims, error) {
	token, err := p.verifier.Verify(ctx, raw)
	if err != nil {
		// Wrapped, not replaced: the underlying reason (bad signature, wrong
		// issuer, unknown kid) belongs in the log. ErrInvalid is what callers
		// branch on.
		return nil, fmt.Errorf("%w: %s", ErrInvalid, err)
	}

	var claims struct {
		Email string                       `json:"email"`
		Roles map[string]map[string]string `json:"urn:zitadel:iam:org:project:roles"`
	}
	if err := token.Claims(&claims); err != nil {
		return nil, fmt.Errorf("%w: reading claims: %s", ErrInvalid, err)
	}

	roles := make([]string, 0, len(claims.Roles))
	for role := range claims.Roles {
		roles = append(roles, role)
	}

	return &Claims{
		Subject:   token.Subject,
		Email:     claims.Email,
		Audience:  token.Audience,
		Issuer:    token.Issuer,
		ExpiresAt: token.Expiry,
		Roles:     roles,
	}, nil
}

// Config is what the service needs to verify tokens.
type Config struct {
	// Issuer is Zitadel's origin, e.g. https://auth.tesserix.app.
	Issuer string
	// ProjectID is the Platform Console project. Both the audience this API
	// requires and the project whose roles it reads.
	ProjectID string
	// Enabled is false when the service is running without authentication.
	//
	// It exists for the window in which the platform API serves only /health
	// and /ready and has no module to protect. It must become impossible to
	// run with this false once a module ships — see the guard in the router.
	Enabled bool
}

// Validate refuses a configuration that would authenticate nothing.
func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	var missing []string
	if c.Issuer == "" {
		missing = append(missing, "ZITADEL_ISSUER")
	}
	if c.ProjectID == "" {
		missing = append(missing, "ZITADEL_PROJECT_ID")
	}
	if len(missing) > 0 {
		return fmt.Errorf("authentication is enabled but %v are unset", missing)
	}
	return nil
}

// discoveryTimeout bounds startup discovery. Without it a slow or unreachable
// Zitadel turns a failed start into a hung one, which reads as a stuck rollout
// rather than a broken dependency.
const discoveryTimeout = 10 * time.Second

// NewVerifierFromConfig wires the real parser, or returns nil when
// authentication is disabled.
func NewVerifierFromConfig(ctx context.Context, cfg Config) (*Verifier, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if !cfg.Enabled {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()

	parser, err := NewOIDCParser(ctx, cfg.Issuer)
	if err != nil {
		return nil, err
	}
	return NewVerifier(parser, cfg.ProjectID), nil
}

// ErrAuthDisabled is returned when something asks for a principal on a service
// running without authentication.
var ErrAuthDisabled = errors.New("authentication is disabled")
