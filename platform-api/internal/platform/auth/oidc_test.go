package auth

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
)

// The organization that grants roles on this project. Zitadel nests it inside
// each role's value — see projectRolesClaim. Taken from the same real decoded
// tokens as the payloads below, and matching REAL_ORG_ID in
// `packages/platform-auth/src/zitadel.test.ts`.
const orgID = "386377229942128837"

// The payloads below are the claim SHAPES of two real tokens decoded from the
// live Zitadel instance while diagnosing #433 — a `mark8ly-catalog-reader`
// service-user access token and the operator access token
// `apps/console/lib/platform-api.ts` presents to this API. They are written out
// as JSON literals with the claim names spelled in full, deliberately: a payload
// built by calling projectRolesClaim would only prove the code agrees with
// itself, which is exactly the property the broken flat-claim version also had.
const (
	// A service user carries the project-scoped claim ONLY. No flat claim, no
	// `urn:zitadel:iam:org:id`, and the client is named by `client_id` rather
	// than `azp`. This is the token that read as role-less for the whole life
	// of the bug.
	serviceUserPayload = `{
		"sub": "386401234567890123",
		"client_id": "mark8ly-catalog-reader",
		"urn:zitadel:iam:org:project:386377618200461939:roles": {
			"read-plan-catalog": {"386377229942128837": "tesserix.auth.tesserix.app"}
		}
	}`

	// An operator carries BOTH forms, with identical contents. This is what
	// settles the question of whether reading only the project-scoped claim
	// regresses operators: it does not, so no flat-claim fallback exists.
	// Note the absent `email` — real operator access tokens have none, which is
	// a separate, unfixed audit-attribution defect in verify.go's Kind
	// heuristic and deliberately not this test's subject.
	operatorPayload = `{
		"sub": "386380123456789012",
		"urn:zitadel:iam:org:id": "386377229942128837",
		"urn:zitadel:iam:org:project:386377618200461939:roles": {
			"adjust-balance": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"billing": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"crm": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"execute-refund": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"hard-delete": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"mass-send": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"platform": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"publish-catalog": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"read": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"respond": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"rotate-credentials": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"support": {"386377229942128837": "tesserix.auth.tesserix.app"}
		},
		"urn:zitadel:iam:org:project:roles": {
			"adjust-balance": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"billing": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"crm": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"execute-refund": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"hard-delete": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"mass-send": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"platform": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"publish-catalog": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"read": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"respond": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"rotate-credentials": {"386377229942128837": "tesserix.auth.tesserix.app"},
			"support": {"386377229942128837": "tesserix.auth.tesserix.app"}
		}
	}`

	// The operator's ID-token shape, reduced to the one claim that matters
	// here: the flat form and nothing else. Pinned as a test so that accepting
	// it later — the "just fall back to the flat claim" widening — is a visible
	// change to an assertion rather than a quiet behaviour drift.
	flatClaimOnlyPayload = `{
		"sub": "386380123456789012",
		"urn:zitadel:iam:org:project:roles": {
			"read": {"386377229942128837": "tesserix.auth.tesserix.app"}
		}
	}`
)

// decodePayload turns a token payload literal into the map Parse decodes into.
// A failure here is a broken test fixture, not a behaviour under test.
func decodePayload(t *testing.T, payload string) map[string]json.RawMessage {
	t.Helper()
	var claims map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &claims); err != nil {
		t.Fatalf("fixture payload is not valid JSON: %v", err)
	}
	return claims
}

// rolesOf reads the project-scoped claim the production code would read for
// this deployment's project, sorted so assertions do not depend on Go's
// randomised map iteration order.
func rolesOf(t *testing.T, payload string) []string {
	t.Helper()
	roles := rolesFromClaims(decodePayload(t, payload), projectRolesClaim(projectID))
	slices.Sort(roles)
	return roles
}

// The literal is spelled out rather than composed, because composing it would
// reproduce the function's own logic and pass for a claim name no token
// carries.
func TestProjectRolesClaimIsTheProjectScopedName(t *testing.T) {
	const want = "urn:zitadel:iam:org:project:386377618200461939:roles"
	if got := projectRolesClaim(projectID); got != want {
		t.Fatalf("projectRolesClaim(%q) = %q, want %q", projectID, got, want)
	}
}

// The regression this whole change exists for: before the fix this returned
// nothing, and the service user got a 403 it could not distinguish from a
// missing grant.
func TestServiceUserRolesAreRead(t *testing.T) {
	got := rolesOf(t, serviceUserPayload)
	want := []string{string(CapReadPlanCatalog)}
	if !slices.Equal(got, want) {
		t.Fatalf("service user roles = %v, want %v", got, want)
	}
}

// Reading only the project-scoped claim must not cost operators anything —
// their real access token carries it too.
func TestOperatorRolesAreRead(t *testing.T) {
	got := rolesOf(t, operatorPayload)
	want := []string{
		"adjust-balance", "billing", "crm", "execute-refund", "hard-delete",
		"mass-send", "platform", "publish-catalog", "read", "respond",
		"rotate-credentials", "support",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("operator roles = %v, want %v", got, want)
	}
}

// The deliberate NON-fallback. The flat claim is not read, because `aud`
// narrows which application a token is for, not whose roles are being read —
// see projectRolesClaim.
func TestFlatClaimAloneYieldsNoRoles(t *testing.T) {
	if got := rolesOf(t, flatClaimOnlyPayload); len(got) != 0 {
		t.Fatalf("flat claim alone yielded roles %v, want none", got)
	}
}

// A misconfigured Zitadel can put something other than an object here. Each
// shape must degrade to "no roles" — which verify.go names ErrNoRoles — rather
// than failing the token as malformed, which would report a configuration gap
// as a broken caller. Mirrors extractRoles()'s cases in
// `packages/platform-auth/src/zitadel.test.ts`.
func TestNonObjectRolesClaimYieldsNoRoles(t *testing.T) {
	claim := projectRolesClaim(projectID)
	for name, value := range map[string]string{
		"an array":            `["read"]`,
		"a string":            `"read"`,
		"null":                `null`,
		"a number":            `7`,
		"an object of arrays": `{"read": ["not-an-org-map"]}`,
	} {
		t.Run(name, func(t *testing.T) {
			raw := map[string]json.RawMessage{claim: json.RawMessage(value)}
			got := rolesFromClaims(raw, claim)
			// The last case is the reason the value is decoded as
			// json.RawMessage: the roles are the KEYS, so an unexpected inner
			// shape must not discard them.
			if name == "an object of arrays" {
				if !slices.Equal(got, []string{"read"}) {
					t.Fatalf("roles = %v, want [read] — the keys do not depend on the value shape", got)
				}
				return
			}
			if len(got) != 0 {
				t.Fatalf("roles = %v, want none", got)
			}
		})
	}
}

// Absent is not an error, and the empty slice is non-nil so callers can append
// or range without a nil check.
func TestAbsentRolesClaimYieldsEmptyNonNilSlice(t *testing.T) {
	got := rolesFromClaims(map[string]json.RawMessage{}, projectRolesClaim(projectID))
	if got == nil {
		t.Fatal("roles = nil, want an empty non-nil slice")
	}
	if len(got) != 0 {
		t.Fatalf("roles = %v, want none", got)
	}
}

// Email decides only Principal.Kind, a logging heuristic, so an odd shape must
// not fail the token.
func TestStringFromClaims(t *testing.T) {
	raw := decodePayload(t, `{"email": "mahesh@tesserix.test", "name": 7}`)
	if got := stringFromClaims(raw, "email"); got != "mahesh@tesserix.test" {
		t.Fatalf("email = %q, want mahesh@tesserix.test", got)
	}
	if got := stringFromClaims(raw, "name"); got != "" {
		t.Fatalf("non-string claim = %q, want empty", got)
	}
	if got := stringFromClaims(raw, "absent"); got != "" {
		t.Fatalf("absent claim = %q, want empty", got)
	}
}

// Fails closed BEFORE any network call, so this needs no issuer: an empty
// project id would build `urn:zitadel:iam:org:project::roles`, which no token
// carries, reproducing #433 for every caller.
func TestNewOIDCParserRefusesAnEmptyProjectID(t *testing.T) {
	parser, err := NewOIDCParser(context.Background(), "https://auth.tesserix.app", "")
	if err == nil {
		t.Fatal("NewOIDCParser accepted an empty project id, want an error")
	}
	if parser != nil {
		t.Fatalf("NewOIDCParser returned a parser alongside an error: %#v", parser)
	}
}

// The org id is not read by this service today; asserted only so the fixtures
// stay recognisable as the real tokens they were taken from.
func TestFixturesNestTheGrantingOrg(t *testing.T) {
	raw := decodePayload(t, serviceUserPayload)
	var byRole map[string]map[string]string
	if err := json.Unmarshal(raw[projectRolesClaim(projectID)], &byRole); err != nil {
		t.Fatalf("service user roles claim: %v", err)
	}
	if _, ok := byRole[string(CapReadPlanCatalog)][orgID]; !ok {
		t.Fatalf("role value = %v, want it keyed by org %s", byRole, orgID)
	}
}
