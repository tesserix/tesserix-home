---
id: 260908-mc1
slug: machine-credential
date: 2026-09-08
issue: 618
kind: quick
branch: feat/618-console-machine-credential
---

# The console can call platform-api without an operator (#618)

Entitlement parity (#146) only runs when someone presses a button. It cannot run
on the nightly CronJob, because `fetchProductEntitlements` reaches
`platformRequest` -> `resolvePlatformApiToken`, which resolves **the operator's**
Zitadel token from their session. A CronJob has no session and cannot mint one.

Price parity runs unattended because it reads Stripe and Postgres, both of which
have machine identities. Anything reading *platform-api* does not. The
asymmetry is structural, and it has already cost two design revisions in #146 —
Task 4's seed had to become a server action for the same reason.

## What already exists — verified, and it is most of the model

- **platform-api already models service identities.** `PrincipalKind` is
  `KindOperator` | `KindService` (`platform-auth/verify.go:54,57`).
- **There is already a machine capability bucket.** `Machines` in
  `platform-auth/capabilities.go:130`, mirrored by `MACHINE_CAPABILITIES` in
  `packages/platform-auth/src/capabilities.ts:269`.
- **`RequireAnyCapability` already exists** for precisely this shape: its doc
  says "a route reachable by two different KINDS of principal that hold
  different capabilities for the same reason", with #152's tickets routes as the
  precedent.

So this is not new machinery. It is one capability, one route change, and a
token path.

## The finding that shapes it

`GET /v1/billing/entitlements` requires `CapBilling`, and **`CapBilling` is not a
machine capability and must not become one.** `capabilities.go:123-129` is
explicit that `Machines` is "a third bucket, not a subset of Surfaces or Verbs:
those two describe an operator's console session — where they work, what they
may do there. A machine holds neither concept, so forcing it into one would
misstate what it is rather than clarify it."

Adding `CapBilling` to `Machines` would therefore be the wrong fix even though it
is the shortest one. The right shape is a machine capability of its own, exactly
as `CapReadPlanCatalog` and `CapReadPromoCatalog` already are for products
reading console contracts. This is the mirror image: the console reading a
product's entitlements.

## Decisions, settled — do not re-open these

1. **A new machine capability, not a widened operator one.** Named for what it
   reads, following the two existing machine read capabilities.
2. **The route accepts EITHER**, via `RequireAnyCapability`. An operator with
   `billing` keeps working — the console's own surfaces depend on it — and a
   machine with the new capability is admitted for the same reason.
3. **A separate `resolveMachineToken`, never a fallback inside
   `resolvePlatformApiToken`.** If one function silently returned a machine token
   when no session existed, every operator-facing read would quietly succeed as
   the machine after a session expired — auditing the wrong principal and
   widening what an unauthenticated request can see. Two functions, and the
   caller states which it wants.
4. **The Go and TS capability lists must both change.** `capabilities.go` says it
   mirrors `capabilities.ts`; a capability in one and not the other is a grant
   that works on one side of the estate only.

## THE INFRASTRUCTURE HALF I CANNOT DO

Provisioning the Zitadel `client_credentials` identity, storing its secret, and
wiring ESO needs Zitadel admin access. **This plan delivers the code only.**

Until the credential exists, entitlement parity stays operator-initiated: the
machine path is present, tested, and unused. That is deliberate and must be
stated on #618 rather than left to be discovered — a merged PR titled "machine
credential" that does not make parity continuous would otherwise read as done.

Whoever provisions it should note the grant is real: an identity that can read
every product's billing surface. It should hold the narrowest capability that
works, and it must not be the identity the operator path uses.

## Tasks

- **T1 — the capability, in both languages.** Add it to `Machines`
  (`platform-auth/capabilities.go`) and `MACHINE_CAPABILITIES`
  (`packages/platform-auth/src/capabilities.ts`), with whatever test asserts the
  two lists agree. If no such test exists, that is worth knowing — say so.
- **T2 — the route accepts a machine.** `RequireAnyCapability` on
  `/v1/billing/entitlements` only. Do not widen the sibling billing routes:
  subscriptions and trials have no machine caller and granting one is a
  decision nobody has made.
- **T3 — `resolveMachineToken` in the console**, and `fetchProductEntitlements`
  able to use it. Wire nothing to the CronJob yet: without the credential it
  would fail every night, which is worse than not running.

## Done means

- [ ] A service principal holding the new capability can read `/v1/billing/entitlements`
- [ ] An operator with `billing` still can
- [ ] A principal with neither is refused
- [ ] Go and TS capability lists agree, with a test that fails if they diverge
- [ ] `resolveMachineToken` cannot be reached by accident from the session path
- [ ] #618 records exactly what remains: provisioning, and wiring the CronJob after it
