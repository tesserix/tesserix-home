package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// projectRolesClaim names the claim Zitadel puts project roles in.
//
// Shaped as {"read": {"<orgId>": "<orgDomain>"}} — the KEYS are the roles, and
// each value maps the granting organization's id to its primary domain.
//
// The name is PROJECT-SCOPED: `urn:zitadel:iam:org:project:{projectId}:roles`.
// This service used to read the flat `urn:zitadel:iam:org:project:roles`
// instead, which is the form an operator's ID token carries. A service user's
// ACCESS token carries only the project-scoped form, so every machine caller
// extracted zero roles, toCapabilities produced nothing, and Verify returned
// ErrNoRoles — indistinguishable from a genuinely missing grant (#433). A real
// operator access token was decoded alongside a real service-user one and
// carries BOTH forms with identical contents, so reading only the
// project-scoped name serves both callers and no flat-claim fallback is needed.
//
// That fallback is deliberately NOT added. Accepting the flat claim would widen
// this path to a token minted for some other project, and the audience check in
// Verify does not close that gap: `aud` narrows WHICH APPLICATION a token is
// for, not which project's roles are being read. The same reasoning, and the
// same rejection, is written out on ZitadelMachineConfig.projectId in
// `packages/platform-auth/src/zitadel.ts`.
//
// {projectId} comes from explicit configuration (Config.ProjectID) rather than
// from the token's own `aud`, even though the two are equal in this deployment.
// `aud` answers "who is this token for"; the project id answers "whose roles am
// I reading". Sourcing the second from the first would be correct only by
// coincidence, and a future Zitadel project/application layout where they
// diverge would silently read the wrong claim — returning no roles — instead of
// failing loudly.
//
// As with the flat claim, this one is absent from `claims_supported` in the
// discovery document: its presence depends on the project asserting roles AND
// the application adding them to the token. When either is off the token
// verifies perfectly and carries nothing, which is what ErrNoRoles exists to
// name.
func projectRolesClaim(projectID string) string {
	return "urn:zitadel:iam:org:project:" + projectID + ":roles"
}

// OIDCParser verifies a token's signature against the issuer's JWKS.
//
// go-oidc keeps its own key cache and refetches on an unknown `kid`, so key
// rotation needs no handling here. Building a verifier per request would defeat
// that and hammer the issuer, so one is built at startup and reused.
type OIDCParser struct {
	verifier *oidc.IDTokenVerifier
	// rolesClaim is the project-scoped claim name this parser reads, resolved
	// once at startup because it depends on configuration and so cannot be a
	// constant or a struct tag. See projectRolesClaim.
	rolesClaim string
}

// NewOIDCParser performs issuer discovery once, at startup.
//
// Discovery is a network call, so a failure here means the service does not
// start — deliberately. A service that starts without being able to verify
// tokens can only fail closed on every request, which is a harder outage to
// read than a refusal to boot.
//
// An empty projectID is refused for the same fail-closed reason. Without the
// guard the claim name would be built as `urn:zitadel:iam:org:project::roles`,
// which no token carries, so every caller would extract zero roles and be
// rejected with ErrNoRoles — the exact silent failure #433 was. Config.Validate
// already requires ZITADEL_PROJECT_ID, but this constructor is exported and a
// future caller can construct a parser directly, bypassing that reader, so the
// guard belongs here too. (`verifyMachineAuthHeader` in
// `packages/platform-auth/src/zitadel.ts` re-checks its audience for exactly
// this reason.)
func NewOIDCParser(ctx context.Context, issuer, projectID string) (*OIDCParser, error) {
	if projectID == "" {
		return nil, errors.New("zitadel project id is required to read the project-scoped roles claim")
	}
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
		rolesClaim: projectRolesClaim(projectID),
	}, nil
}

// rolesFromClaims reduces Zitadel's roles claim to its keys.
//
// The value is shaped {"<role>": {"<orgId>": "<orgDomain>"}}; only the outer
// keys are roles. Decoded as json.RawMessage rather than
// map[string]map[string]string so an unexpected inner shape yields no roles
// instead of failing the whole token — the roles are the keys and do not depend
// on the value parsing.
//
// Returns an empty, non-nil slice when the claim is absent or is not a JSON
// object (an array, a string and null all reach here from a misconfigured
// Zitadel). Callers get "no roles", which verify.go turns into ErrNoRoles — the
// correct, named failure — rather than ErrInvalid, which would report a
// configuration gap as a malformed token. This mirrors extractRoles() in
// `packages/platform-auth/src/zitadel.ts`, which rejects the same shapes.
func rolesFromClaims(raw map[string]json.RawMessage, claim string) []string {
	value, ok := raw[claim]
	if !ok {
		return []string{}
	}
	var byRole map[string]json.RawMessage
	if err := json.Unmarshal(value, &byRole); err != nil {
		return []string{}
	}
	roles := make([]string, 0, len(byRole))
	for role := range byRole {
		roles = append(roles, role)
	}
	return roles
}

// stringFromClaims reads a string-valued claim, or "" when it is absent or is
// not a JSON string.
//
// It never fails the token. The only claim read through it is `email`, which
// feeds Principal.Kind — documented in verify.go as a logging and audit
// heuristic that NEVER authorises. Rejecting a token because a claim that
// decides nothing has an odd shape would trade an attribution gap for an
// outage.
func stringFromClaims(raw map[string]json.RawMessage, claim string) string {
	value, ok := raw[claim]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(value, &s); err != nil {
		return ""
	}
	return s
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

	// Decoded by key rather than into a tagged struct: the roles claim's name
	// depends on the configured project id (see projectRolesClaim), and a
	// struct tag cannot carry a value that is only known at runtime.
	var claims map[string]json.RawMessage
	if err := token.Claims(&claims); err != nil {
		return nil, fmt.Errorf("%w: reading claims: %s", ErrInvalid, err)
	}

	return &Claims{
		Subject:   token.Subject,
		Email:     stringFromClaims(claims, "email"),
		Audience:  token.Audience,
		Issuer:    token.Issuer,
		ExpiresAt: token.Expiry,
		Roles:     rolesFromClaims(claims, p.rolesClaim),
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

	parser, err := NewOIDCParser(ctx, cfg.Issuer, cfg.ProjectID)
	if err != nil {
		return nil, err
	}
	return NewVerifier(parser, cfg.ProjectID), nil
}

// ErrAuthDisabled is returned when something asks for a principal on a service
// running without authentication.
var ErrAuthDisabled = errors.New("authentication is disabled")
