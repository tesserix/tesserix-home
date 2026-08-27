---
slug: conformance-entity-row
date: 2026-08-27
mode: quick
issue: 365
repo: design-system
---

# Enforce §8.9's entity row in @tesserix/admin-conformance

Follow-up to tesserix-home#375, which added contract §8.9 (v2.4) naming §3.4's
entity row. That amendment shipped **unenforced**, and says so in its own text —
which is the failure §8.8 was written to avoid. This closes it.

**Repo: `design-system`** (`packages/admin-conformance`), not tesserix-home.
Branch off `main`.

## Why this specific check

`@tesserix/admin-conformance` already declares `entities` and runs §4.1's
envelope and §4.3's timestamps against it. It has **no assertion on the row's own
fields** — which is exactly how Kora and mark8ly diverged while a suite was
already running against both, and how platform-api came to drop `sublabel`
entirely (tesserix-home#364).

## What §8.9 requires

| field | rule |
|---|---|
| `id` | required, non-empty string |
| `label` | required, non-empty string |
| `sublabel` | optional; **if present**, a non-empty string |
| `created_at` | optional; §4.3 already checks its format |
| `source` | products **must not** send it |
| `type` | products **may** send it; nothing depends on it |

Two subtleties that decide whether the check is right:

- **Absent `sublabel` is correct, not a finding.** mark8ly sends none and is
  conformant. The check must never require it. What it catches is `sublabel:
  null` and `sublabel: ""` — a product signalling "no disambiguator" through a
  value instead of omitting the key, which is what makes a consumer render a
  placeholder where it should render nothing.
- **`source` is a `fail`, not a warning.** §8.9's wording is normative ("must
  not"), and the reason is that a row asserting its own origin is precisely the
  field that must not be forgeable — platform-api stamps it from the request.
  Neither current implementer sends it, so this fails nobody today; it exists so
  the third one cannot start.

## Implementation

`src/assertions/entity-row.ts`, following `src/assertions/empty.ts` closely —
same shape, same `Finding` API (`fail`/`pass`/`skip` from `../finding`), same
commenting register (each check's comment says what real failure it prevents,
not what it asserts).

- `export const ENTITY_ROW_SECTION = "8.9"`
- `export function checkEntityRow(endpointId, section, body): Finding[]`
- **Skip for every endpoint except `entities`.** This is a §3.4 row rule, not a
  cross-cutting §4 one. Return a `skip` with a reason, as `empty.ts` does when
  an envelope has no collection.
- An empty `data` array is a `skip`, not a `pass`: a product with no rows has
  demonstrated nothing about its row shape, and reporting `pass` would claim
  coverage the run does not have.
- Report **per-row**, identifying the row by index and by its `id` where one is
  readable — a finding that says only "a row is malformed" against 50 rows is
  not actionable.
- Do not stop at the first bad row; a product with a systematic problem should
  see it as such.

Wire it in:
- export from `src/assertions/index.ts`
- call it in `src/runner.ts` beside `checkTimestamps` / `checkEmptyResult`

## Tests

`src/assertions/entity-row.test.ts`, matching the existing assertion tests:

- a conformant row with `sublabel` → pass
- a conformant row **without** `sublabel` → pass (this is the one that matters:
  mark8ly must stay conformant)
- `sublabel: null` → fail
- `sublabel: ""` → fail
- missing `id` / missing `label` → fail, each named
- `id`/`label` present but empty string → fail
- `id` as a number → fail (a JSON number id is a real shape, and `String(id)`
  in a consumer would paper over it)
- a row carrying `source` → fail
- a row carrying `type` → pass (explicitly allowed)
- two bad rows → two findings, not one
- a non-`entities` endpoint → skip
- empty `data` → skip, not pass

## Release

The repo uses changesets. Add one — **minor**, so `0.4.0 → 0.5.0`, matching how
§8.8 landed at v0.4.0. The changeset text should say what a product must do to
stay conformant, not just what changed.

## Verification

- The package's own test suite, plus `pnpm build` / `typecheck` / `lint` as the
  repo defines them. Read `package.json` for the actual script names rather than
  assuming.

## NOT in this PR

- Any change to tesserix-home, including §8.9's "Conformance: not yet enforced"
  paragraph. That paragraph becomes wrong once this **publishes**, not when it
  merges, and updating it is a separate change against the real published
  version number.
- Any change to kora or mark8ly.
