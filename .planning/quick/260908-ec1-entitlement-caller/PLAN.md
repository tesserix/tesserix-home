---
id: 260908-ec1
slug: entitlement-caller
date: 2026-09-08
issue: 146
kind: quick
branch: feat/entitlement-seed-and-parity-caller
---

# The entitlement model gets a caller (#146 follow-up)

#146 shipped a table, a seed action and a parity comparator, and **nothing
invokes any of them**. Production holds zero entitlement rows and has never
recorded an entitlement parity run. The code is correct by test and unexercised
by anything real.

That is the state #146 was written to end, one level up: a console holding a
second copy of the entitlement matrix that nothing checks is worse than holding
none, because it displays with authority.

## The constraint that shapes this — measured, not assumed

**Entitlement parity cannot run unattended.** `performEntitlementParityCheck`
reaches `fetchProductEntitlements` -> `platformRequest` ->
`resolvePlatformApiToken`, which resolves the OPERATOR's Zitadel token from
their session. The nightly CronJob has no session and cannot mint one: there is
no machine credential in the console -> platform-api direction.

Price parity runs unattended because it reads Stripe and Postgres, both of which
have machine credentials. The asymmetry is structural, not an oversight.

**Decision (2026-09-08): operator-initiated now, machine credential later.**
Both controls are audited operator actions. The nightly CronJob is untouched and
still runs price parity only. What this costs is stated rather than implied:
entitlement drift is detected WHEN SOMEONE LOOKS, not continuously. The
follow-up that makes it continuous is a Zitadel `client_credentials` identity
for console -> platform-api, and it is filed rather than assumed.

## Decisions, settled — do not re-open these

1. **The seed must NEVER run automatically from inside the parity check.** A
   `not_bootstrapped` result triggering a seed would make parity seed from the
   product and then compare against the product — agreeing forever, by
   construction. It would convert the one check that can detect drift into a
   check that cannot. Two separate operator actions, always.
2. **The CronJob is not touched.** Adding an entitlement pass to
   `runParityCheckJob` cannot work (no session) and would fail every night.
3. **Both actions are audited**, through the wrappers their siblings use.
   `rerunParityCheckAction` is the precedent for the parity one;
   `seedEntitlementsAction` already carries its own.
4. **`0053`'s separation must hold at the surface too.** An entitlement run's
   outcome must never render inside the price observation strip's verdict —
   the strip is #327's gate evidence and its meaning does not widen here.

## Tasks

- **T1 — an audited server action for the parity run.** Wrap
  `runEntitlementParityCheck(source)` the way `rerunParityCheckAction` wraps
  `runAllParityPairs`: same audit-wrapper shape, same "describe what the run
  PRODUCED" summary, same `revalidatePath`. `unattributable` is a distinct
  outcome from a recorded run and must not read as one.
- **T2 — the surface.** A section on the catalog page carrying: whether the
  console is seeded (row count, or "not seeded"), the last entitlement parity
  outcome, and the two controls. Visually and semantically separate from the
  price observation strip, per decision 4.

## Done means

- [ ] An operator can seed entitlements from the product, and see the result
- [ ] An operator can run entitlement parity, and see the outcome
- [ ] "Not seeded" is distinguishable from "seeded and clean" and from "drifted"
- [ ] The price observation strip's verdict is unchanged in meaning and content
- [ ] The nightly CronJob is untouched
- [ ] The machine-credential follow-up is filed, naming what it unblocks
