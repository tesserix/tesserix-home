---
quick_id: 260831-d9u
slug: fix-433-project-scoped-zitadel-roles-cla
date: 2026-08-31
issue: tesserix-home#433
status: complete
branch: fix/433-project-scoped-roles-claim
---

# platform-api now reads the project-scoped Zitadel roles claim

`OIDCParser.Parse` decoded roles from the flat `urn:zitadel:iam:org:project:roles`
via a struct tag. A Zitadel service user's access token carries only the
project-scoped `urn:zitadel:iam:org:project:{projectId}:roles`, so every machine
caller extracted zero roles and was rejected with `ErrNoRoles` — indistinguishable
from a genuinely missing grant. The parser now builds the claim name from the
configured project id and reads that one only.

No flat-claim fallback was added. The plan's pre-gathered evidence settles why it
is unnecessary: a real operator access token carries BOTH forms with identical
contents, so reading only the project-scoped name does not regress operators.
Adding the fallback would be the widening `packages/platform-auth/src/zitadel.ts`
already rejects — `aud` narrows which application a token is for, not whose roles
are being read.

## Files changed

- `platform-api/internal/platform/auth/oidc.go`
  - Deleted the exported `ZitadelRolesClaim` constant (no callers repo-wide) and
    replaced it with `projectRolesClaim(projectID string) string`.
  - `OIDCParser` gained a `rolesClaim` field, resolved once at startup.
  - `NewOIDCParser(ctx, issuer, projectID string)` — fails closed on an empty
    `projectID` before any network call, because the claim name
    `urn:zitadel:iam:org:project::roles` would reproduce #433 for every caller.
  - `Parse` decodes into `map[string]json.RawMessage` (a struct tag cannot carry
    a runtime-dependent claim name) and delegates to two new pure functions:
    `rolesFromClaims` (returns an empty non-nil slice for absent/non-object
    claims, so `verify.go` reports the named `ErrNoRoles` rather than
    `ErrInvalid`) and `stringFromClaims` (for `email`, which feeds only the
    logging-heuristic `Principal.Kind` and so must never fail a token).
  - `NewVerifierFromConfig` passes `cfg.ProjectID`.
- `platform-api/internal/platform/auth/verify.go` — `Claims.Roles` docstring now
  names the project-scoped claim and the deliberate non-fallback.
- `platform-api/internal/platform/auth/oidc_test.go` — NEW. `Parse` had no test
  at all, which is how this survived.
- `docs/PLATFORM-API-CONVENTIONS.md`, `docs/ADR-003-CONSOLE-TOPOLOGY.md`,
  `docs/api/plan-catalog-read.md` — see Deviations.

## Tests

Assert against the two REAL payload shapes recorded in the plan, written as JSON
literals with the claim names spelled in full — a payload built by calling
`projectRolesClaim` would only prove self-consistency, the property the broken
version also had.

- service-user payload (project-scoped claim only) yields its one role,
  `read-plan-catalog`
- operator payload (both claims, identical) yields all 12 roles
- flat-claim-only payload yields NO roles — the non-fallback, pinned so a future
  "accept either" is a visible assertion change
- roles claim as array / string / null / number yields no roles; an object whose
  VALUES are unexpected still yields its keys (why `json.RawMessage` is used)
- absent claim yields an empty non-nil slice
- `projectRolesClaim("386377618200461939")` equals the exact literal
- `NewOIDCParser` with an empty project id returns an error and no parser

`projectID` is the existing package-level const in `verify_test.go`; not
redeclared.

## Verification output

`gofmt -l .` from `platform-api/` printed nothing. `go build ./...` and
`go vet ./...` both produced no output (success). `go test ./...` — full suite
green; the tail of the run:

```
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/audit	5.102s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/auth	4.864s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/config	5.189s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/database	5.138s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/federation	5.342s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx	5.313s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency	5.245s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/paging	5.409s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/reqid	5.207s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb	5.381s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/write	5.306s
```

No package reported FAIL. The new tests, run verbosely:

```
--- PASS: TestProjectRolesClaimIsTheProjectScopedName (0.00s)
--- PASS: TestServiceUserRolesAreRead (0.00s)
--- PASS: TestOperatorRolesAreRead (0.00s)
--- PASS: TestFlatClaimAloneYieldsNoRoles (0.00s)
--- PASS: TestNonObjectRolesClaimYieldsNoRoles (0.00s)
--- PASS: TestAbsentRolesClaimYieldsEmptyNonNilSlice (0.00s)
--- PASS: TestStringFromClaims (0.00s)
--- PASS: TestNewOIDCParserRefusesAnEmptyProjectID (0.00s)
--- PASS: TestFixturesNestTheGrantingOrg (0.00s)
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/auth	0.519s
```

## Deviations from the plan

1. **Three docs corrected, which the plan did not list.** `grep` for the flat
   claim found three living docs asserting that this service — and a service
   user's token — use `urn:zitadel:iam:org:project:roles`. Left alone they would
   restate to the next reader the exact false fact the issue disproved. Each got
   a minimal correction naming the project-scoped form: the conventions doc, the
   ADR (as an explicit amendment note rather than a silent rewrite, since an ADR
   is a dated record), and the plan-catalog API doc. Nothing beyond the claim
   name is described differently.
   `docs/superpowers/plans/2026-08-29-catalog-read-endpoint.md` was deliberately
   NOT touched — it is a historical plan, not a live description.
2. **Two helpers, not one.** The plan specified `rolesFromClaims`. Moving to a
   claim map also moved `email` off its struct tag, so `stringFromClaims` was
   added rather than inlining an unchecked `json.Unmarshal` at the call site.
3. **Out of scope, untouched as instructed:** `verify.go`'s `Kind` heuristic
   still labels every real operator `KindService`, because a real operator access
   token has no `email` claim. Audit attribution only — `Kind` never authorises.
   Needs its own issue and its own decision about what should distinguish the two
   kinds now that email cannot.

## Known stubs

None.
