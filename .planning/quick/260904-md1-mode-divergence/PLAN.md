---
id: 260904-md1
slug: mode-divergence
date: 2026-09-04
issue: 527
kind: quick
---

# Report when test and live stop serving the same catalog (#527)

## The premise this protects, and why it is load-bearing

#328 skipped a week-long live-mode observation window on one argument: mark8ly's
comparison is *console catalog ↔ compiled Go catalog*, neither side is
mode-dependent, and the console provably serves the same catalog for both modes —
so test-mode evidence stands in for live.

That argument is **conditional on the two modes agreeing**, and nothing checks it.
mark8ly cannot: it reads one mode (`CONSOLE_CATALOG_MODE`) and is structurally
incapable of comparing them. The console holds both publications in one table.

## Measured against production, 2026-09-04 — the shorthand has already broken

```
live  rev=fb9c1667-3b35-45e6-a7b8-9a7ea8aa3b5e     ← revisions DIVERGED
test  rev=00000000-0000-0000-0000-000000000001

test_rows 78 · live_rows 78 · content symmetric difference 0   ← content IDENTICAL
```

So **a check keyed on `revision_id` would fire a false positive today**, on a state
where the modes agree exactly. #327 P2b's first live publish (a `+1` minor-unit
change and a revert) moved live's publication history; the served bytes are
unchanged.

A check that cries wolf on day one is a check people learn to ignore — the exact
failure `0034`'s `not_bootstrapped` reasoning already warned this estate about:
*"noise that trains people to ignore the report — and the report is the only
evidence the window is made of."*

**So: compare CONTENT, never `revision_id`.**

## Tasks

### T1 — The query and its repository function

In `plan-catalog-repo.ts`, beside the existing publication reads. Diff the SERVED
rows across modes — the same join `readCatalogAmounts` uses:

```sql
WITH served AS (
  SELECT pub.mode, p.lookup_key, p.plan, p.period, p.tier,
         a.currency, a.unit_amount_minor, a.tax_behavior
    FROM plan_catalog_publications pub
    JOIN plan_catalog_prices  p ON p.revision_id = pub.revision_id
    JOIN plan_catalog_amounts a ON a.price_id = p.id
   WHERE pub.superseded_at IS NULL AND p.source = $1
)
-- symmetric difference between mode='test' and mode='live'
```

`plan`, `period` and `tier` are in the compared tuple deliberately — tesserix/mark8ly#631
added them to the Go-side `Diff` because they are the fields the serving lookup keys
on, and comparing only amounts would leave them unwatched.

**The trap that must not be repeated.** A mode with NO current publication must not
read as agreement. This is the same distinction mark8ly's `Result.Compared` vs
`Result.Differences` exists for: *"a failed read must not look like agreement:
reporting zero differences when the console could not be reached would make an
outage indistinguishable from a clean run."* Live was never bootstrapped for long
stretches of this project's life, and "live has no publication" is a legitimate,
common state that is emphatically **not** "the modes agree". Model it as its own
outcome, and give it its own test.

### T2 — The surface

Beside the parity surface — the observation strip area on
`/platform/billing/catalog`, which now collapses to one line (`observation-strip.tsx`).

It reads as a **statement of an assumption, not an error**. Divergent content is a
legitimate state once live publishing is enabled; what must not happen is reaching
it while other reasoning still assumes otherwise.

When they do diverge, name the consequence rather than the fact: mark8ly's test-mode
comparison no longer evidences live, so either the mode it reads changes, or the
live-mode window #328 skipped has to be started for real. A number alone does not
tell an operator what it costs them.

Its read is independent — its own slot in `page.tsx`'s `Promise.allSettled` with its
own `SurfaceState`, like every other read on that page. A failure here must not
degrade the catalog or the authoring panel.

## Explicitly out of scope

- Changing what mark8ly reads, or its `SharedRevisionID` tripwire. That guard is
  honest about being a staleness detector rather than a divergence detector; this
  issue is where the real detector lives, and it should not repeat the proxy.
- The nightly parity cron. This is a surface-time question about two rows, not a
  scheduled job.

## Verification

```
pnpm --filter console test:unit
pnpm --filter console typecheck
pnpm --filter console lint
pnpm --filter console build
```

`build` is not optional — it is the only gate that sees server-only code reaching
the browser bundle (#539). Integration tests here run real in-process pglite with
no skip path, so a DB test either runs or errors.
