---
id: 260909-eg1
slug: entitlement-staleness-gauge
date: 2026-09-09
issue: 618
kind: quick
branch: feat/618-entitlement-staleness-gauge
---

# Entitlement parity gets the staleness gauge its schedule now earns (#618)

#618 named three things it would unblock. Two of them have landed:

- **Entitlement parity on the nightly CronJob** — `runEntitlementPass` in
  `apps/console/scripts/parity-check.ts` (#626, merged 2026-09-09).
- **A machine path that is not the operator path** — `resolveMachineToken`
  (#622), the `read-entitlements` machine capability, and
  `RequireAnyCapability` on `/v1/billing/entitlements`.

The third has not, and #618 says exactly why it was held back:

> A staleness gauge for entitlements **that means something**, because there
> would be a schedule for it to be silent against. […] adding one would be
> dishonest while nothing runs on a schedule.

There is now a schedule. This is that gauge.

## Measured starting state, 2026-09-08

Verified against the running cluster rather than the merge, because the merge
is not the precondition — the credential and the environment are:

| Fact | Value |
|---|---|
| `console-secrets` | carries `ZITADEL_MACHINE_CLIENT_ID` and `ZITADEL_MACHINE_CLIENT_SECRET` |
| CronJob `console-parity-check` env | both, `optional: true`, plus `ZITADEL_ISSUER` / `ZITADEL_PROJECT_ID` / `PLATFORM_API_ORIGIN` (tesserix-k8s#1054, merged) |
| CronJob image | `main-710264a` — carries #626's entitlement pass |
| Last completed run | 2026-09-08 02:15Z, on the PREVIOUS image: two price lines, **no entitlement line** |
| `/api/internal/metrics` | three series, all `check_kind = 'price'` |

So the first entitlement row will be written by the 02:15Z run **after** this
plan is written, and no entitlement evidence is machine-readable today.

## What is added

Two series, mirroring the price pair one axis over:

- `tesserix_console_entitlement_parity_differences{source}`
- `tesserix_console_entitlement_parity_last_clean_timestamp_seconds{source}`

`NaN` for a run that produced no comparison, `0` (the epoch) for never-clean —
the same two conventions `differenceValue` and `lastCleanValue` already
document, and for the same reason: neither absence may read as agreement.

### `source` is the only label, and `mode` MUST NOT become one

`readLatestEntitlementRun`'s header already argues this for the console's own
surface: the entitlement check is not run per (mode, source) pair, and the mode
it is filed under is the mode **the product reported reading**, taken off the
response because the console cannot see mark8ly's `CONSOLE_CATALOG_MODE`.

For a gauge that argument gets sharper, because a label is not a display
choice — it is a series identity:

**`CONSOLE_CATALOG_MODE` moves at mark8ly's live-key swap (mark8ly#371).** A
`mode`-labelled gauge would, at that moment, retire
`…{mode="test"}` — frozen at its last value, staleness climbing forever, alerting
on a mode nobody reads — and start `…{mode="live"}` at the epoch, alerting
because it has never been clean. Two false alerts and no true one, on the day
the estate can least afford noise. `source` is stable across the swap; the mode
stays where it already is, on the console surface, as an answer rather than a key.

## Naming: `entitlement`, not `stripe`

The existing series are `tesserix_console_stripe_parity_*`, and the route
header is explicit that the name says WHICH TWO THINGS are compared — worded
around a pre-existing collision with mark8ly's `mark8ly_catalog_parity_*`. The
entitlement check compares the console's published matrix against the product's
`plangate` and never touches Stripe, so it cannot borrow `stripe`.

## Tasks

- **T1 — `readLastCleanEntitlementRun(source)`** in `plan-catalog-repo.ts`,
  beside `readLatestEntitlementRun`. `readLastCleanRuns` cannot answer it: it
  filters `check_kind = 'price'`, and the reason its price sibling exists at all
  — the latest run is not the last CLEAN run once a check starts failing —
  applies here unchanged.
- **T2 — the two series** in `app/api/internal/metrics/route.ts`, with HELP text
  written for someone reading an alert annotation at 3am, and tests asserting
  every source emits a sample, a never-run source reads as NaN/epoch rather than
  0 differences, and no free text escapes.
- **T3 — correct the comments #626 made wrong.** `readLatestEntitlementRun` still
  says the check "runs when an operator presses a button". It runs nightly now,
  and a comment that misattributes its own reason is the defect this estate
  produces most.

## Explicitly NOT in this change

**The Prometheus alert rule.** It belongs in tesserix-k8s, and it must not land
before the first nightly entitlement row exists — a `time() - <epoch> > threshold`
rule shipped today fires immediately, correctly, and for a state that resolves
itself at 02:15Z without anyone doing anything. An alert whose first act is to
cry wolf teaches its audience to ignore it.

The gauge is honest the moment it ships: it will read `NaN` / epoch, which is
the true statement that no entitlement run has been recorded yet. Ship the
rule once the first row is observed.

## Done means

- [ ] Both series present for every `CATALOG_SOURCES` entry, always
- [ ] A source that has never run emits NaN and the epoch, never 0 differences
- [ ] No `mode` label on either series
- [ ] No stored `error` text can reach the body
- [ ] `readLatestEntitlementRun`'s stale operator-only comment corrected
- [ ] #618 records what remains: the alert rule, after the first nightly row
