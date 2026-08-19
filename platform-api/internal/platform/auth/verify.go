package auth

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// The failure modes, kept DISTINCT on purpose.
//
// `zitadel.ts` documents the trap this service is most likely to hit:
//
//	"the token verifies perfectly and carries no roles at all, which presents
//	 as an application bug rather than a configuration gap"
//
// A single ErrUnauthorized would reproduce that exactly. Each of these names a
// different thing to go and fix, so a misconfiguration announces itself instead
// of looking like broken code. They are surfaced in logs, never to the caller —
// the client gets one 401.
var (
	// ErrNotJWT means the token is opaque. The Zitadel application's Auth Token
	// Type is Bearer rather than JWT, so there is nothing to verify locally.
	// This service has no introspection path by design (ADR-003 D8).
	ErrNotJWT = errors.New("token is not a JWT — check the application's Auth Token Type in Zitadel")

	// ErrAudience means the token is valid but was not minted for this API. The
	// caller is missing the project audience scope
	// `urn:zitadel:iam:org:project:id:{projectId}:aud`.
	ErrAudience = errors.New("token audience does not include this API's project")

	// ErrNoRoles means signature, issuer, audience and expiry all check out and
	// the roles claim is absent or empty. Almost always configuration: the
	// project is not asserting roles, the application is not adding them to the
	// ACCESS token (as opposed to the ID token), or the principal genuinely
	// holds no grant.
	ErrNoRoles = errors.New("token carries no project roles — check role assignment and that roles are on the ACCESS token")

	// ErrExpired is separated from a bad signature because it is the one
	// failure that is routine rather than suspicious.
	ErrExpired = errors.New("token has expired")

	// ErrInvalid covers signature, issuer and malformed claims.
	ErrInvalid = errors.New("token failed verification")
)

// PrincipalKind is who is calling. ADR-003 D8's two types.
type PrincipalKind string

const (
	// KindOperator is a human acting through the console.
	KindOperator PrincipalKind = "operator"
	// KindService is a product calling the platform API directly — the caller
	// that `/api/internal/*` serves today (#152).
	KindService PrincipalKind = "service"
)

// Principal is an authenticated caller.
type Principal struct {
	// Subject is Zitadel's stable user id. The audit trail's actor.
	Subject string
	// Email is present for operators and usually absent for machine users.
	Email string
	// Capabilities are the known role keys the token carried. Unknown roles are
	// already dropped.
	Capabilities []Capability
	// Kind is a HEURISTIC, for logging and audit only.
	//
	// Zitadel does not mark a client_credentials token distinctly, so this is
	// inferred from the presence of an email claim. NEVER authorise on it:
	// authorisation is by capability, which is attested by the issuer, whereas
	// this is a guess about the shape of a claim. A machine user with an email
	// would be misclassified and nothing about access should change if so.
	Kind PrincipalKind
}

// Has reports whether the principal holds a capability.
//
// Fails closed on every degenerate input, matching hasCapability() in
// capabilities.ts: no wildcard, no superuser short-circuit, no "if none are set,
// allow". Those are the shapes that turn an authorisation check into decoration.
func (p Principal) Has(required Capability) bool {
	if len(p.Capabilities) == 0 || !known(required) {
		return false
	}
	return slices.Contains(p.Capabilities, required)
}

// Claims is the subset of a Zitadel token this service reads.
type Claims struct {
	Subject   string
	Email     string
	Audience  []string
	Issuer    string
	ExpiresAt time.Time
	// Roles is the `urn:zitadel:iam:org:project:roles` claim, already reduced
	// to its keys. Zitadel shapes it as {"read": {"<orgId>": "<orgDomain>"}};
	// the keys are the roles.
	Roles []string
}

// TokenParser verifies a raw token's signature and returns its claims.
//
// An interface so the policy below — audience, roles, principal shape — is
// testable without a live Zitadel or a fake JWKS server. The signature check
// itself is the one part that must not be reimplemented for tests.
type TokenParser interface {
	Parse(ctx context.Context, raw string) (*Claims, error)
}

// Verifier turns a raw bearer token into a Principal.
type Verifier struct {
	parser TokenParser
	// audience is the Zitadel PROJECT id. The console already requests
	// `urn:zitadel:iam:org:project:id:{projectId}:aud`, so its tokens carry it
	// and no new Zitadel application is needed for this API to have an
	// audience of its own.
	audience string
	now      func() time.Time
}

func NewVerifier(parser TokenParser, projectID string) *Verifier {
	return &Verifier{parser: parser, audience: projectID, now: time.Now}
}

// Verify checks a raw token and returns the principal it attests.
func (v *Verifier) Verify(ctx context.Context, raw string) (*Principal, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, ErrInvalid
	}

	// Checked BEFORE parsing, so an opaque token reports the configuration
	// problem it is rather than a generic parse failure. A Zitadel Bearer token
	// is an opaque string; a JWT is three dot-separated segments.
	if strings.Count(raw, ".") != 2 {
		return nil, ErrNotJWT
	}

	claims, err := v.parser.Parse(ctx, raw)
	if err != nil {
		return nil, err
	}

	// Expiry before audience: an expired token is routine and should not be
	// reported as a misconfigured caller.
	if !claims.ExpiresAt.IsZero() && v.now().After(claims.ExpiresAt) {
		return nil, ErrExpired
	}

	if !slices.Contains(claims.Audience, v.audience) {
		return nil, fmt.Errorf("%w: want %s, got %v", ErrAudience, v.audience, claims.Audience)
	}

	caps := toCapabilities(claims.Roles)
	if len(caps) == 0 {
		// Deliberately reported even when the token DID carry roles that this
		// service does not know: "held roles, none recognised" and "held no
		// roles" are both "cannot authorise anything", and distinguishing them
		// in the error would leak the role vocabulary to an unauthorised
		// caller. The raw roles go to the log instead.
		return nil, fmt.Errorf("%w (raw roles: %v)", ErrNoRoles, claims.Roles)
	}

	kind := KindService
	if claims.Email != "" {
		kind = KindOperator
	}

	return &Principal{
		Subject:      claims.Subject,
		Email:        claims.Email,
		Capabilities: caps,
		Kind:         kind,
	}, nil
}
