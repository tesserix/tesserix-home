---
quick_id: 260831-e4k
slug: fix-450-operator-identity
date: 2026-08-31
issue: tesserix-home#450
---

# platform-api: identify operators by client_id, and resolve their name/email from userinfo

`verify.go:174` infers the principal kind from `claims.Email != ""`. A real
operator ACCESS token carries no `email` claim, so every human is recorded as
`KindService` and `Principal.Email` is empty for every operator.

## Evidence gathered before planning — established fact, do NOT re-derive

Do not query the cluster, the database, or Zitadel. Everything needed is here.

**Operator access token** (decrypted from the live `operator_api_tokens` row —
the real credential `apps/console/lib/platform-api.ts` presents to this API):

```
client_id                                  = "386382971877196703"   <- console's ZITADEL_CLIENT_ID
sub                                        = "386888878927118733"
urn:zitadel:iam:org:id                     = "386377229942128837"
urn:zitadel:iam:user:resourceowner:id      = "386377229942128837"
urn:zitadel:iam:user:resourceowner:name    = "TESSERIX"
urn:zitadel:iam:org:project:386377618200461939:roles  = 12 roles
urn:zitadel:iam:org:project:roles                     = the same 12 roles
aud                                        = ["386382971877196703","386377618200461939"]
email, amr, auth_time                      = ABSENT
```

**Service-user access token** (freshly minted `client_credentials` for
`mark8ly-catalog-reader`, verified against the deployed API):

```
client_id                                  = "mark8ly-catalog-reader"
sub                                        = "388414281508455697"
urn:zitadel:iam:org:project:386377618200461939:roles = ["read-plan-catalog"]
aud                                        = ["386377618200461939"]
email, urn:zitadel:iam:org:id, urn:zitadel:iam:user:resourceowner:* = ABSENT
```

**`GET https://auth.tesserix.app/oidc/v1/userinfo` with the operator access
token returns HTTP 200** carrying `email`, `name`, `preferred_username`,
`given_name`, `family_name`, `sub`, the org and resourceowner claims, and both
roles claims. So `name` AND `email` are both recoverable — userinfo is the
OIDC-sanctioned way to get profile claims for an access token, and the console
already requests the `email` and `profile` scopes
(`apps/console/lib/auth/oidc.ts:93`), which is why this works.

**Why not a claim-presence heuristic.** `urn:zitadel:iam:org:id` and the
`resourceowner` claims happen to be present on the operator token and absent on
the machine one, and using that would be the same class of inference that
produced #433 and #450. It is also demonstrably fragile: the FIRST
`client_credentials` mint in this investigation came back with **no roles claim
at all**, because the request omitted the `urn:zitadel:iam:org:projects:roles`
scope. Claim presence varies with requested SCOPES, not only with caller kind.
`client_id` is signed, always present on both, and compared against an
explicitly configured value — the same shape as #433's fix.

## Current damage: latent, not realised

`console_audit_log` has 0 rows; all 76 `crm_activities` rows are from a
migration; the single `platform_ticket_replies` row is dated 05-02 and predates
platform-api auth. Nothing is polluted — this fix lands ahead of the first real
write. Do not write any backfill or migration.

## Ordering constraint (IMPORTANT)

`ZITADEL_CONSOLE_CLIENT_ID` is being added to `tesserix-k8s`
(`charts/apps/platform-api/values.yaml` and `values-prod.yaml`) in a separate PR
that lands FIRST. This task must nonetheless behave correctly when the variable
is absent — see Task 1.

## Tasks

### Task 1 — identify the caller by `client_id`

In `platform-api/internal/platform/auth/`:

- Add `ClientID string` to `Claims`, read from the `client_id` claim via the
  existing `stringFromClaims` helper in `oidc.go`. Note in its docstring that a
  `client_credentials` access token names the client as `client_id` and carries
  **no `azp`** (`azp` is an ID-token concept); `packages/platform-auth/src/zitadel.ts`
  documents the same asymmetry on `MachineIdentity.clientId`.
- Add `ConsoleClientID string` to `Config`, from `ZITADEL_CONSOLE_CLIENT_ID`.
- Replace the email inference in `Verify`:

  ```go
  kind := KindService
  if v.consoleClientID != "" && claims.ClientID == v.consoleClientID {
      kind = KindOperator
  }
  ```

- **`ConsoleClientID` is OPTIONAL, not required by `Config.Validate`.** It
  affects audit labelling only and never authorisation, so making it a boot
  dependency would let an attribution setting take the service down. But it must
  not fail SILENTLY the way #433 did: log once at startup, at WARN, when
  authentication is enabled and it is unset — say that every principal will be
  recorded as a service until it is set. Loud and degraded, not quiet and wrong.
- Update the `Principal.Kind` docstring. It currently explains the email
  heuristic and warns "NEVER authorise on it". Keep that warning — it is still
  true and still important — and replace the mechanism description. Record that
  `client_id` is attested by the issuer, so this is no longer a guess about
  claim shape, while still not being an authorisation input.

### Task 2 — resolve operator name and email from userinfo

- Add `Name string` to `Principal`, beside `Email`.
- Define a resolver interface in the auth package so `Verifier` stays testable
  without a live Zitadel, exactly as `TokenParser` already does:

  ```go
  // ProfileResolver fetches the profile claims an access token does not carry.
  type ProfileResolver interface {
      Resolve(ctx context.Context, rawToken, subject string) (name, email string, err error)
  }
  ```

- Implement it over go-oidc's existing provider — `provider.UserInfo(ctx,
  oauth2.StaticTokenSource(&oauth2.Token{AccessToken: raw}))` — so the endpoint
  comes from the discovery document already fetched at startup rather than a
  second hardcoded URL.
- **Cache by `sub`**, with a TTL (15 minutes is a reasonable default; name the
  constant and justify it in a comment). Cache NEGATIVE results too, on a much
  shorter TTL (~1 minute), so an unreachable IdP is not re-dialled on every
  request. Bound the map so it cannot grow without limit.
- **Bound the call with its own timeout** (a few seconds). Zitadel is now in the
  request path; without a timeout a slow IdP turns every authenticated request
  into a hanging one. The same reasoning is written out at length on
  `REFRESH_DEADLINE_MS` in `apps/console/lib/auth/platform-token.ts` — read it.
- **Fail soft, always.** A userinfo failure must NEVER fail the request: leave
  name and email empty, log at WARN with the subject and the error, and carry
  on. An operator who can be authorised but not named is a worse audit line, not
  a denied one.
- **Only for operators.** Call the resolver only when `kind == KindOperator`.
  A machine principal has no profile to fetch, and the `client_id` check from
  Task 1 is exactly the gate. This keeps machine callers on a pure-local path
  with no network call at all.
- Wire it in `NewVerifierFromConfig`. Keep `NewVerifier(parser, projectID)`
  working as-is for the existing tests — add the resolver through an option or a
  second constructor rather than changing that signature.

### Task 3 — use the recovered identity downstream

- `internal/modules/tickets/internal/handler/handler.go:333` `actorOf` hardcodes
  `Name: ""` with a comment saying "Zitadel's `name` claim is not read by the
  verifier, so an operator's display name is their email here". That is now
  false — pass `principal.Name` and rewrite the comment.
  Consequence worth stating in the commit: `displayName()`
  (`tickets/internal/service/service.go:48`) currently falls all the way through
  to the literal **"Tesserix Support"** for every operator, so a human agent's
  reply to a merchant is signed as the platform. With Name populated it is
  signed with their name.
- `internal/modules/crm/internal/service/service.go:99` `auditActor()` falls back
  to `a.Subject` when email is empty — which is every operator today. No code
  change needed; it starts recording emails once Task 2 populates them. Do NOT
  change its fallback: the fallback is correct for machine principals.

### Task 4 — tests

Extend `oidc_test.go` / `verify_test.go`:

- an operator payload (`client_id` = the configured console id) → `KindOperator`
- a machine payload (`client_id` = `mark8ly-catalog-reader`) → `KindService`
- an unset `ConsoleClientID` → everything is `KindService`, and nothing panics
- `client_id` absent entirely → `KindService`
- the resolver is **not** called for a machine principal (use a fake that records calls)
- a resolver error → request still succeeds, name and email empty
- a resolver timeout → same, and bounded (do not let this test actually sleep for the real timeout)
- cache: a second Verify for the same `sub` does not re-call the resolver; an expired entry does
- negative caching: a failing resolver is not re-called within the negative TTL
- tickets `displayName()` returns the operator's name rather than "Tesserix Support"

Use the REAL claim names and the REAL recorded values above. Do not compose
payloads from the constants the code itself reads — that proves only
self-consistency, which the broken version also had.

Run `gofmt -l . && go build ./... && go vet ./... && go test -count=1 ./...`
from `platform-api/`.

### Task 5 — commit

Single-line conventional commit, no body, no signature. Suggested:
`fix(platform-api): identify operators by client_id and resolve their name and email from userinfo (#450)`
