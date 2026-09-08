# Runbook — granting a machine capability in Zitadel

Written for `read-entitlements` (#618), but the shape is the same for every
capability in `Machines` / `MACHINE_CAPABILITIES`. The console's operator
runbook is `RUNBOOK-ZITADEL-IDENTITY.md`; this is its machine counterpart,
which did not exist.

## The facts, verified against the cluster on 2026-09-08

| | value |
|---|---|
| Zitadel issuer | `https://auth.tesserix.app` |
| Token endpoint | `https://auth.tesserix.app/oauth/v2/token` |
| **Project id** | `386377618200461939` |
| Org id | `386377229942128837` |
| Console OIDC app client id | `386382971877196703` |

**These three ids are not interchangeable and two of them appear in one token.**
Roles are *project*-scoped, so the project id is the one that matters here. The
org id and the OIDC app client id are different values that look equally
plausible in a config field, and swapping them yields self-consistent failures.

`platform-api` verifies against `ZITADEL_PROJECT_ID = 386377618200461939` — the
same project the console uses. Confirmed on both deployments; do not assume it,
re-check if this runbook is old.

## Before you start: the failure this is shaped to avoid

`toCapabilities` **drops** role strings it does not recognise. So a typo in the
role key does not error — it presents as *"this principal holds nothing"* and
denies. A mistyped role and an ungranted role are indistinguishable from the
outside.

The role key must be exactly `read-entitlements`, matching
`platform-auth/capabilities.go` and `packages/platform-auth/src/capabilities.ts`
character for character. A contract test asserts those two agree with each
other; **nothing can check either against Zitadel**, because that needs the
Management API credential #211 is blocked on.

## Where `read-entitlements` actually stands (2026-09-08)

This runbook was written during #618 and the first steps are already done. It is
kept as the general procedure; this section says what is left for THIS
capability, so nobody repeats step 1.

| step | state |
|---|---|
| 1. project role `read-entitlements` | **done** — created 2026-09-08, group `machine`, on project `386377618200461939` |
| 2. machine user `console-entitlements-reader` | **declared** in `tesserix-k8s` `zitadel-bootstrap` values (PR #1050, merged); the reconciler creates it on its next 30-minute run |
| 3. grant the role to it | **remaining** — by hand; role assignments are not declared anywhere |
| 4-6. credential, Secret Manager, ESO | **remaining** — by hand; the credential is readable only at issue time |
| 7. console env | code is on the #618 branch; vars are `ZITADEL_MACHINE_CLIENT_ID` / `_SECRET`, optionally `_TOKEN_URL` and `_PROJECT_ID` |

Note step 2 differs from the general procedure below: machine users in this
estate are **declared in git**, not clicked. `reconcile_machine_users` creates a
missing account and never updates an existing one, so creating one by hand does
not error — it just leaves no declaration, and a rebuilt environment silently
lacks it.

## Steps

1. **Create the project role.** On project `386377618200461939`, add role key
   `read-entitlements`. Display name and group are free text and are not read by
   any code.

2. **Create the machine user.** A new service user for the console — *not* the
   identity the operator path uses, and not one shared with another caller. The
   grant is real: this identity can read every federated product's billing
   surface. It should hold `read-entitlements` and nothing else.

3. **Grant the role to it**, on that project. A role that exists but is not
   granted denies exactly like a role that does not exist.

4. **Create a client secret** for the machine user (`client_credentials`).

5. **Store it in GCP Secret Manager** in project `tesseracthub-480811`,
   following the naming the estate already uses. Note this repo's own history:
   secret names have twice misdescribed which account or mode they hold, so put
   the consumer and the purpose in the name.

6. **Wire it in with ESO** the way the console's other secrets are, into the
   `tesserix` namespace.

7. **Set the console's env** — the client id, the secret reference, and the
   token URL above.

## The scope string, which is where this usually goes wrong

Machine tokens must request the project audience explicitly. mark8ly's working
client uses exactly this shape, and it is the pattern to copy:

```
openid
urn:zitadel:iam:org:project:id:386377618200461939:aud
urn:zitadel:iam:org:projects:roles
```

Without the `:aud` scope the token verifies but fails the audience check —
`ErrAudience`, "token audience does not include this API's project".

## What a machine token looks like, and why it surprises people

A machine access token does **not** carry the flat `urn:zitadel:iam:org:project:roles`
claim an operator token carries. It carries the **project-scoped** form:

```
urn:zitadel:iam:org:project:386377618200461939:roles
```

It also does not carry `urn:zitadel:iam:org:id` at all. Code that reads the org
claim to identify a caller will find nothing — that is expected for a machine,
not a misconfiguration.

## Verifying the grant worked

Request a token with the scope above, then check the decoded claims carry the
project-scoped roles claim containing `read-entitlements`. Then call
`GET /v1/billing/entitlements` on platform-api:

- **200** — granted and working.
- **403** — authenticated, capability missing. The role is not granted, or its
  key does not match the string above. This is the typo case.
- **401** — the token itself did not verify: wrong issuer, expired, or the
  `:aud` scope is missing.

Do not stop at "not 401". A 403 means the credential is fine and the grant is
not, and those need different people to fix them.

## After it works

Entitlement parity can then be wired to the nightly CronJob. Until the grant
exists it must NOT be wired: it would fail every night, which is noisier and
less honest than not running. See #618.
