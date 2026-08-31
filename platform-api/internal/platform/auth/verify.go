package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
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
	// Email is the operator's address, RESOLVED FROM USERINFO rather than read
	// from the token: an operator's access token carries no `email` claim at
	// all. Empty for machine users, and empty for an operator whose userinfo
	// lookup failed — see ProfileResolver, which fails soft by design.
	Email string
	// Name is the operator's display name, from the same userinfo lookup.
	//
	// It reached a merchant briefly and no longer does. tickets' displayName()
	// (tickets/internal/service/service.go) signed a reply with it; a reply is
	// now signed "Tesserix Support" unconditionally, because a staff member's
	// name and personal email are not a merchant's to see. Attribution is by
	// Subject, in author_user_id.
	//
	// Which leaves Name — and Email above — with no reader in this service.
	// They are kept deliberately, pending a decision on whether the userinfo
	// resolver earns its round trip at all; do not add a consumer for either
	// without answering that first.
	Name string
	// Capabilities are the known role keys the token carried. Unknown roles are
	// already dropped.
	Capabilities []Capability
	// Kind is for logging, audit and profile resolution only.
	//
	// NEVER authorise on it. Authorisation is by capability, and keeping these
	// two apart is what stops a change to caller CLASSIFICATION from silently
	// becoming a change to caller ACCESS.
	//
	// It is decided by comparing the token's `client_id` against the
	// explicitly configured console client id (Config.ConsoleClientID). That
	// claim is attested by the issuer and present on both an operator's and a
	// machine user's access token, so this is no longer the guess it was: it
	// used to be inferred from the presence of an `email` claim, and since a
	// real operator ACCESS token carries none, EVERY human was recorded as a
	// service (#450). The same class of inference produced #433.
	//
	// A claim-presence heuristic is not the fix either. Which claims a token
	// carries depends on the SCOPES the caller requested, not on what kind of
	// caller it is — the first client_credentials mint taken during #450's
	// investigation came back with no roles claim at all for exactly that
	// reason.
	//
	// When ConsoleClientID is unset every principal is KindService, which is
	// the safe direction: it costs attribution and grants nothing.
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
	Subject string
	// Email is very often empty. An operator's access token carries no `email`
	// claim; Principal.Email is recovered from userinfo instead.
	Email string
	// ClientID is the `client_id` claim — the Zitadel application or machine
	// user the token was minted for. Present on BOTH kinds of access token,
	// and the input to the Kind decision in Verify.
	//
	// Read from `client_id` and NOT from `azp`: a client_credentials access
	// token names its client as `client_id` and carries no `azp` at all, `azp`
	// being an ID-token concept. `packages/platform-auth/src/zitadel.ts`
	// documents the same asymmetry on MachineIdentity.clientId.
	ClientID  string
	Audience  []string
	Issuer    string
	ExpiresAt time.Time
	// Roles is the project-scoped
	// `urn:zitadel:iam:org:project:{projectId}:roles` claim, already reduced to
	// its keys. Zitadel shapes it as {"read": {"<orgId>": "<orgDomain>"}}; the
	// keys are the roles.
	//
	// NOT the flat `urn:zitadel:iam:org:project:roles`, which a service user's
	// access token does not carry — reading that one gave every machine caller
	// an empty slice and so an ErrNoRoles it could not have fixed (#433). See
	// projectRolesClaim in oidc.go for why the flat form is not accepted as a
	// fallback.
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
	// consoleClientID is the console's Zitadel client id, from
	// ZITADEL_CONSOLE_CLIENT_ID. Empty means "not configured", which makes
	// every principal a service — see Principal.Kind.
	consoleClientID string
	// profiles resolves an operator's name and email, and is nil when nothing
	// wired one (tests, and any deployment whose issuer has no userinfo).
	profiles ProfileResolver
	// profileTimeout bounds the userinfo call. See resolveProfile.
	profileTimeout time.Duration
	log            *slog.Logger
}

// Option configures a Verifier at construction.
//
// Options rather than more constructor parameters because everything below is
// genuinely optional: a Verifier with none of them still verifies tokens
// correctly, it just attributes them less well. Keeping NewVerifier's signature
// as it was is not incidental either — every existing test builds one this way,
// and a signature change would have edited the tests that guard this change.
type Option func(*Verifier)

// WithConsoleClientID names the client id whose tokens are operators.
func WithConsoleClientID(clientID string) Option {
	return func(v *Verifier) { v.consoleClientID = clientID }
}

// WithProfileResolver enables userinfo lookup for operators.
//
// The resolver is wrapped in a cache here rather than by the caller so that no
// wiring can accidentally put userinfo on the request path uncached.
func WithProfileResolver(resolver ProfileResolver) Option {
	return func(v *Verifier) {
		if resolver == nil {
			return
		}
		v.profiles = newProfileCache(resolver, v.now)
	}
}

// WithLogger replaces the logger the fail-soft paths warn on.
func WithLogger(log *slog.Logger) Option {
	return func(v *Verifier) {
		if log != nil {
			v.log = log
		}
	}
}

func NewVerifier(parser TokenParser, projectID string, opts ...Option) *Verifier {
	v := &Verifier{
		parser:         parser,
		audience:       projectID,
		now:            time.Now,
		profileTimeout: profileTimeout,
		log:            slog.Default(),
	}
	for _, opt := range opts {
		opt(v)
	}
	return v
}

// profileTimeout bounds the userinfo call Verify makes for an operator.
//
// Zitadel is now IN THE REQUEST PATH, which it was not before. Without a
// deadline of its own a slow IdP does not fail requests, it hangs them — the
// worse outcome, because a hung request holds a connection and reports as
// latency rather than as an error. The same reasoning is written out at length
// on REFRESH_DEADLINE_MS in `apps/console/lib/auth/platform-token.ts`.
//
// Three seconds: long enough that an ordinary round trip to auth.tesserix.app
// never trips it, short enough that tripping it is invisible beside the
// database work the request is about to do anyway. Exceeding it costs an
// unnamed operator on one audit line, never a refusal.
const profileTimeout = 3 * time.Second

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

	// Compared against an explicitly configured client id rather than inferred
	// from claim shape. See Principal.Kind for why the email heuristic this
	// replaces recorded every operator as a service (#450).
	kind := KindService
	if v.consoleClientID != "" && claims.ClientID == v.consoleClientID {
		kind = KindOperator
	}

	name, email := "", claims.Email
	if kind == KindOperator {
		// ONLY for operators. A machine user has no profile to fetch, so this
		// gate is also what keeps machine callers — the products calling
		// /api/internal/* — on a purely local path with no network call in
		// their request at all.
		name, email = v.resolveProfile(ctx, raw, claims.Subject, claims.Email)
	}

	return &Principal{
		Subject:      claims.Subject,
		Email:        email,
		Name:         name,
		Capabilities: caps,
		Kind:         kind,
	}, nil
}

// resolveProfile recovers an operator's name and email, and NEVER fails.
//
// Fail-soft is the whole design, not a convenience. This runs after the token
// has already been verified, its audience checked and its capabilities read —
// the caller is authorised, and everything still to be decided is about how
// well the resulting audit line reads. An operator who can be authorised but
// not named is a worse audit line; an operator refused because Zitadel's
// userinfo endpoint was briefly slow is an outage. The WARN is what stops the
// degraded state from being silent, which is the mistake #433 was.
//
// Falls back to the token's own email, which is empty for an operator today
// but costs nothing to prefer over discarding a claim that is there.
func (v *Verifier) resolveProfile(ctx context.Context, raw, subject, claimEmail string) (string, string) {
	if v.profiles == nil {
		return "", claimEmail
	}

	ctx, cancel := context.WithTimeout(ctx, v.profileTimeout)
	defer cancel()

	name, email, err := v.profiles.Resolve(ctx, raw, subject)
	if err != nil {
		v.log.WarnContext(ctx, "could not resolve the operator's profile — the audit trail will name only their subject",
			slog.String("subject", subject),
			slog.String("error", err.Error()),
		)
		return "", claimEmail
	}
	if email == "" {
		email = claimEmail
	}
	return name, email
}
