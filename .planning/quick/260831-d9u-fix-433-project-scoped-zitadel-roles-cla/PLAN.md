---
quick_id: 260831-d9u
slug: fix-433-project-scoped-zitadel-roles-cla
date: 2026-08-30
issue: tesserix-home#433
---

# platform-api: read the project-scoped Zitadel roles claim

`platform-api/internal/platform/auth/oidc.go:71` decodes roles from the FLAT
claim `urn:zitadel:iam:org:project:roles`, hardcoded as a struct tag, and
`verify.go` routes both operator and service callers through it. A Zitadel
**access token** minted for a service user carries only the PROJECT-SCOPED form
`urn:zitadel:iam:org:project:{projectId}:roles`. Role extraction therefore
returns `[]` for every machine caller, `toCapabilities` yields nothing, and the
caller gets a 403 indistinguishable from a genuinely missing grant.

## Evidence gathered before planning (do not re-derive)

Two REAL tokens from the live instance, decoded 2026-08-30:

1. **Service user** `mark8ly-catalog-reader` (from issue #433):
   - roles at `urn:zitadel:iam:org:project:386377618200461939:roles` ONLY
   - NO flat roles claim, NO `urn:zitadel:iam:org:id`, NO `azp` (client is `client_id`)

2. **Operator** — decrypted from the live `operator_api_tokens` row, the actual
   access token `apps/console/lib/platform-api.ts` presents to this API:
   - carries **BOTH** `urn:zitadel:iam:org:project:386377618200461939:roles`
     AND the flat `urn:zitadel:iam:org:project:roles`, with **identical**
     contents (12 roles: adjust-balance, billing, crm, execute-refund,
     hard-delete, mass-send, platform, publish-catalog, read, respond,
     rotate-credentials, support)
   - `aud: ["386382971877196703", "386377618200461939"]`
   - HAS `urn:zitadel:iam:org:id`
   - **NO `email` claim**

Consequence that settles the issue's open question: because a real operator
access token carries the project-scoped claim too, reading project-scoped ONLY
does **not** regress operators. No flat-claim fallback is needed, and adding one
would be the widening `packages/platform-auth/src/zitadel.ts` deliberately
rejected — the audience check narrows "which application", not "which project".

## Out of scope (file separately, do NOT fix here)

The operator token has no `email` claim, so `verify.go`'s `kind := KindService;
if claims.Email != "" { kind = KindOperator }` labels every real human as
`KindService`. `Kind` is documented as a logging/audit heuristic that never
authorises, so this is an audit-attribution bug, not a security hole. It is a
separate defect with a separate decision (what should distinguish the two kinds
now that email cannot) and must not be bundled into this fix.

## Tasks

### Task 1 — read the project-scoped claim, from configuration

In `platform-api/internal/platform/auth/oidc.go`:

- Delete the `ZitadelRolesClaim` constant (it is exported but has no callers
  outside this file — verified repo-wide) and replace it with a builder:

  ```go
  func projectRolesClaim(projectID string) string {
      return "urn:zitadel:iam:org:project:" + projectID + ":roles"
  }
  ```

- Give `OIDCParser` a `rolesClaim string` field.
- Change the signature to `NewOIDCParser(ctx context.Context, issuer, projectID string)`.
  **Fail closed**: return an error when `projectID` is empty, rather than
  building the claim name `urn:zitadel:iam:org:project::roles`, which no token
  carries and which would return `[]` roles for every caller — the exact silent
  failure being fixed. `Config.Validate` already requires `ZITADEL_PROJECT_ID`,
  but `NewOIDCParser` is exported and a future caller can bypass that reader,
  so the guard belongs here too.
- Update the call in `NewVerifierFromConfig` (oidc.go:143) to pass `cfg.ProjectID`.

- In `Parse`, the claim name is now dynamic, so a struct tag cannot express it.
  Decode into `map[string]json.RawMessage` and pull both fields by key. Extract
  the role-key reduction into a pure, testable function:

  ```go
  // rolesFromClaims reduces Zitadel's roles claim to its keys.
  //
  // The value is shaped {"<role>": {"<orgId>": "<orgDomain>"}}; only the
  // outer keys are roles. Decoded as json.RawMessage rather than
  // map[string]map[string]string so an unexpected inner shape yields no
  // roles instead of failing the whole token — the roles are the keys and
  // do not depend on the value parsing.
  func rolesFromClaims(raw map[string]json.RawMessage, claim string) []string
  ```

  Return an empty (non-nil) slice when the claim is absent or is not a JSON
  object. `verify.go` already turns "no roles" into `ErrNoRoles`, which is the
  correct, named failure.

- Replace the `ZitadelRolesClaim` docstring with one that states the shape, that
  the claim is project-scoped and why the project id comes from explicit
  configuration rather than from `aud` (`aud` answers "who is this token for";
  the project id answers "whose roles am I reading" — they coincide in this
  deployment, so sourcing one from the other would be right only by
  coincidence), and that the flat claim is deliberately NOT accepted. Cite the
  matching reasoning in `packages/platform-auth/src/zitadel.ts`.

- Update the `Claims.Roles` docstring in `verify.go` (it names the flat claim).

### Task 2 — tests that assert against REAL claim names

There is no `oidc_test.go` today; `Parse` is untested, which is how this
survived. Create `platform-api/internal/platform/auth/oidc_test.go` covering
`rolesFromClaims` and `projectRolesClaim`. Use the two real payload shapes
recorded above — **not** hand-built payloads using the constant the code itself
reads, which prove only self-consistency.

At minimum:
- a service-user payload (project-scoped claim only) yields its 1 role
- an operator payload (both claims, identical) yields its roles
- a payload carrying ONLY the flat claim yields **no** roles — the deliberate
  non-fallback, pinned so a future "accept either" is a visible test change
- a payload whose roles claim is a JSON array / string / null yields no roles
- `projectRolesClaim("386377618200461939")` equals the exact literal
  `urn:zitadel:iam:org:project:386377618200461939:roles`
- `NewOIDCParser` with an empty projectID returns an error

Run `go build ./... && go vet ./... && go test ./...` from `platform-api/`.

### Task 3 — commit

Single-line conventional commit, no signature, no body. Suggested:
`fix(platform-api): read the project-scoped Zitadel roles claim, which is the only one a machine token carries (#433)`
