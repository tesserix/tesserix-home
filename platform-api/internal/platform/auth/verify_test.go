package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

const projectID = "386377618200461939"

// The two client ids these tests turn on, both taken from real decoded tokens
// (see the payloads in oidc_test.go).
const (
	// consoleClientID is the console's Zitadel application — ZITADEL_CLIENT_ID
	// in `apps/console`, and what ZITADEL_CONSOLE_CLIENT_ID must be set to.
	consoleClientID = "386382971877196703"
	// machineClientID is a service user. Zitadel names a machine by its
	// username here, not by a numeric id.
	machineClientID = "mark8ly-catalog-reader"
	// operatorSubject is the `sub` of the operator token the console presents.
	operatorSubject = "386888878927118733"
)

// A parser that returns whatever the test hands it. The signature check is the
// one thing not reimplemented here — that belongs to go-oidc, and faking it
// would mean asserting against a fake.
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
//
// Note the empty Email. That is not an omission for brevity — a real operator
// access token carries no `email` claim at all, which is precisely why the old
// email heuristic recorded every human as a service (#450) and why Kind is
// decided by ClientID here.
func validClaims() *Claims {
	return &Claims{
		Subject:   operatorSubject,
		Email:     "",
		ClientID:  consoleClientID,
		Audience:  []string{consoleClientID, projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(30 * time.Minute),
		Roles:     []string{"read", "crm"},
	}
}

// machineClaims is a service user's access token: named by client_id, with no
// email, no org claims, and the project audience only.
func machineClaims() *Claims {
	return &Claims{
		Subject:   "388414281508455697",
		ClientID:  machineClientID,
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(30 * time.Minute),
		Roles:     []string{"support"},
	}
}

// verifierFor builds a verifier configured the way a real deployment is —
// with the console's client id known. Tests that want the UNCONFIGURED case
// build their own, because that case is a behaviour worth naming rather than a
// default worth inheriting.
func verifierFor(c *Claims) *Verifier {
	return NewVerifier(stubParser{claims: c}, projectID, WithConsoleClientID(consoleClientID))
}

func TestVerifyReturnsThePrincipal(t *testing.T) {
	got, err := verifierFor(validClaims()).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if got.Subject != operatorSubject {
		t.Errorf("subject: want %s, got %q", operatorSubject, got.Subject)
	}
	if !got.Has(CapCRM) {
		t.Error("want the crm capability")
	}
	if got.Kind != KindOperator {
		t.Errorf("a token minted for the console is an operator, got %q", got.Kind)
	}
}

// The trap `zitadel.ts` documents, and the reason these errors are separate:
// an opaque token must report the CONFIGURATION problem it is, not a generic
// failure that reads as an application bug.
func TestOpaqueTokenIsReportedAsNotAJWT(t *testing.T) {
	// A Zitadel Bearer token is an opaque string, not three segments.
	_, err := verifierFor(validClaims()).Verify(context.Background(), "kAaBbCcDd-opaque-token")

	if !errors.Is(err, ErrNotJWT) {
		t.Fatalf("want ErrNotJWT, got %v", err)
	}
	// The message must name where to go and fix it.
	if !strings.Contains(err.Error(), "Auth Token Type") {
		t.Errorf("the error should name the Zitadel setting, got %q", err)
	}
}

// The second half of the same trap: signature, issuer, audience and expiry all
// pass, and the token carries nothing to authorise with.
func TestValidTokenWithNoRolesIsItsOwnError(t *testing.T) {
	c := validClaims()
	c.Roles = nil

	_, err := verifierFor(c).Verify(context.Background(), jwtShaped)

	if !errors.Is(err, ErrNoRoles) {
		t.Fatalf("want ErrNoRoles, got %v", err)
	}
	if !strings.Contains(err.Error(), "ACCESS token") {
		t.Errorf("the error should point at the access-token setting, got %q", err)
	}
}

// Roles present but none recognised is the same outcome — nothing can be
// authorised — and must not be a different HTTP story.
func TestUnknownRolesOnlyIsTreatedAsNoRoles(t *testing.T) {
	c := validClaims()
	c.Roles = []string{"invented", "Crm", "crm "} // wrong case and a trailing space

	_, err := verifierFor(c).Verify(context.Background(), jwtShaped)

	if !errors.Is(err, ErrNoRoles) {
		t.Fatalf("want ErrNoRoles, got %v", err)
	}
	// The raw roles belong in the log, because a typo'd role key otherwise
	// presents as "holds nothing" with no clue why.
	if !strings.Contains(err.Error(), "invented") {
		t.Errorf("the raw roles should be logged for diagnosis, got %q", err)
	}
}

func TestUnknownRolesAreDroppedButKnownOnesSurvive(t *testing.T) {
	c := validClaims()
	c.Roles = []string{"crm", "not-a-capability", "support"}

	got, err := verifierFor(c).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if len(got.Capabilities) != 2 || !got.Has(CapCRM) || !got.Has(CapSupport) {
		t.Errorf("want exactly crm and support, got %v", got.Capabilities)
	}
}

func TestAudienceMustIncludeTheProject(t *testing.T) {
	c := validClaims()
	c.Audience = []string{"some-other-project"}

	_, err := verifierFor(c).Verify(context.Background(), jwtShaped)

	if !errors.Is(err, ErrAudience) {
		t.Fatalf("want ErrAudience, got %v", err)
	}
	// Naming both sides is what makes this fixable without a debugger.
	if !strings.Contains(err.Error(), projectID) {
		t.Errorf("the error should name the expected audience, got %q", err)
	}
}

func TestAudienceIsAcceptedAlongsideOthers(t *testing.T) {
	c := validClaims()
	// Real Zitadel tokens carry the client id beside the project audience.
	c.Audience = []string{"386382971877196703", projectID}

	if _, err := verifierFor(c).Verify(context.Background(), jwtShaped); err != nil {
		t.Fatalf("a token carrying extra audiences is still for us: %v", err)
	}
}

func TestExpiredTokenIsDistinctFromInvalid(t *testing.T) {
	c := validClaims()
	c.ExpiresAt = time.Now().Add(-time.Minute)

	_, err := verifierFor(c).Verify(context.Background(), jwtShaped)

	// Routine rather than suspicious: an expiring token is the system working,
	// and it should not read like a forged one in the logs.
	if !errors.Is(err, ErrExpired) {
		t.Fatalf("want ErrExpired, got %v", err)
	}
}

// Expiry is checked before audience so a stale token is not reported as a
// misconfigured caller — which would send someone to the Zitadel console for a
// problem solved by logging in again.
func TestExpiryIsReportedBeforeAudience(t *testing.T) {
	c := validClaims()
	c.ExpiresAt = time.Now().Add(-time.Minute)
	c.Audience = []string{"wrong"}

	_, err := verifierFor(c).Verify(context.Background(), jwtShaped)

	if !errors.Is(err, ErrExpired) {
		t.Fatalf("want ErrExpired to win, got %v", err)
	}
}

func TestParserFailureIsPropagated(t *testing.T) {
	v := NewVerifier(stubParser{err: ErrInvalid}, projectID)

	if _, err := v.Verify(context.Background(), jwtShaped); !errors.Is(err, ErrInvalid) {
		t.Fatalf("want ErrInvalid, got %v", err)
	}
}

func TestEmptyTokenIsRefused(t *testing.T) {
	for _, raw := range []string{"", "   "} {
		if _, err := verifierFor(validClaims()).Verify(context.Background(), raw); err == nil {
			t.Errorf("an empty token must be refused, got nil for %q", raw)
		}
	}
}

// A token minted for anything other than the console is a machine. The
// classification is for audit only, which the next test pins down.
func TestATokenFromAnotherClientIsAService(t *testing.T) {
	got, err := verifierFor(machineClaims()).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if got.Kind != KindService {
		t.Errorf("want service, got %q", got.Kind)
	}
	// ADR-003 D8: same path, different roles. A service principal is not a
	// lesser one — it holds exactly what it was granted.
	if !got.Has(CapSupport) {
		t.Error("a service principal must hold its granted capabilities")
	}
}

// Kind must never decide access. If it ever does, then a console client id
// that is unset, wrong, or newly rotated silently changes what a caller may
// do — an attribution setting becoming an authorisation one.
func TestKindDoesNotAffectAuthorisation(t *testing.T) {
	operator := validClaims()
	operator.Roles = []string{"crm"}
	machine := machineClaims()
	machine.Roles = []string{"crm"}

	a, err := verifierFor(operator).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	b, err := verifierFor(machine).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if a.Kind == b.Kind {
		t.Fatal("the fixtures should differ in kind, or this proves nothing")
	}
	if a.Has(CapCRM) != b.Has(CapCRM) {
		t.Error("kind must not change what a principal may do")
	}
}

func TestHasFailsClosed(t *testing.T) {
	// Every shape a permissive implementation would let through.
	empty := Principal{}
	if empty.Has(CapRead) {
		t.Error("a principal with no capabilities must be denied")
	}

	p := Principal{Capabilities: []Capability{CapCRM}}
	for _, wildcard := range []Capability{"admin", "*", "superuser", "owner"} {
		if p.Has(wildcard) {
			t.Errorf("there must be no superuser short-circuit, %q passed", wildcard)
		}
	}
	// A surface must not confer a verb, or the reverse — #261's orthogonality,
	// enforced on this side of the boundary too.
	if p.Has(CapHardDelete) {
		t.Error("holding crm must not confer hard-delete")
	}
	if (Principal{Capabilities: []Capability{CapHardDelete}}).Has(CapCRM) {
		t.Error("holding hard-delete must not confer crm")
	}
}
