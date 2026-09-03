---
id: 260904-cr0
slug: catalog-redesign-p0
date: 2026-09-04
issue: none (UX redesign of /platform/billing/catalog; feeds #521)
kind: quick
---

# The plan catalog screen, reshaped — P0 of the approved redesign

## Why this, now

`/platform/billing/catalog` is 7,428 lines across nine components and renders as
one unbroken column: an always-expanded observation window, then the whole
published catalog, then the whole authoring panel. Every operator arriving to do
one thing scrolls past the other two.

The approved prototype (artifact `abd13f24`, "Plan Catalog Redesign") settles the
shape. This plan implements its **P0** only:

1. collapse the observation window to a one-line strip
2. split the page into **Browse** / **Draft & Publish** tabs
3. a sticky publish rail beside the draft editor
4. search across the 42 lookup keys

**The sequencing reason it is first.** #521 adds promo codes under
`/platform/billing`. Built against today's single-column screen, that surface
would be a fourth stacked section, and the tab shell would then have to be
retrofitted around live code. Built after this, it is one more entry in a tab
array. So the shell is written to take N tabs from the start — a `Promo codes`
tab is a data change, not a structural one.

## What is NOT in this plan

- The prototype's **Products** tab (Stripe Product name/id per plan). Real work,
  not P0, and it needs a read the page does not do today.
- The prototype's **Kora** source rows. The prototype labels them
  "illustrative sample data" in three places; `availableCatalogSources` already
  derives sources from the rows, so a second source appears on its own when one
  is published. Nothing here hardcodes Mark8ly.
- Any change to what publishing DOES. `actions.ts`, `publish-executor`,
  `stripe-write.ts` are untouched. This is composition and presentation only —
  if a diff in this branch changes a Stripe request, it is a mistake.

## Constraints carried in from this estate

- **Server components must not import `@tesserix/web`.** Its barrel is
  `"use client"`, so its exports are `undefined` in a server component and the
  page renders "Element type is invalid" — #539, three days ago. The guard test
  `apps/console/lib/server-component-web-import.guard.test.ts` now holds this;
  any new component that touches the design system carries `"use client"`.
- **Typecheck is not a build.** `tsc --noEmit` and vitest cannot see
  server-only code reaching the browser bundle. Every task runs
  `pnpm --filter console build` before it is called done.
- **pnpm, not npm.** `npm ci` fails here — there is no `package-lock.json`.
- Reuse the kit: `SurfaceTabs` (`components/kit/surface-tabs.tsx`) for tabs,
  `SearchFilterInput` (`components/kit/filter-bar.tsx`) for search. Do not write
  a second tab or a second debounced input.

## Tasks — one atomic commit each

### T1 — The observation window collapses to a strip

`CatalogViews` renders `ObservationWindow` under an always-visible
`<h2>Observation window</h2>`. It becomes a single row: status dot, verdict
word, and a summary phrase ("Satisfied — 7/7 days clean, both pairs"), with a
disclosure that expands to exactly today's content, unchanged.

- New client component `observation-strip.tsx` wrapping the existing
  `ObservationWindow` as its expanded body. `ObservationWindow` itself is not
  rewritten.
- The collapsed summary must distinguish the three day verdicts `dayVerdict`
  already names — `clean` / `dirty` / `gap`. A day that never ran is **not**
  clean, and the strip must not say "clean" for it; that distinction is the
  whole point of `ParityWindowDay.ran` and its comment says so.
- Default collapsed. Not-satisfied defaults **expanded** — the one state an
  operator must not have to click to see.

**Done when:** render tests cover collapsed summary text for satisfied, dirty
and gap windows, plus expand/collapse; the existing `ObservationWindow` tests
still pass untouched.

### T2 — Browse / Draft & Publish tabs

A tab shell between `ConsolePageHeader` and the two panels.

- Browse = today's `CatalogViews` catalog section (source filter, mode toggle,
  publication attribution, `PlanCatalogTabs`).
- Draft & Publish = today's `AuthoringPanel`.
- The shell takes a `tabs` array. Adding `Promo codes` later must not require
  editing the shell.
- The Draft tab carries a count badge — changed-row count when a draft exists,
  and a distinct marker when the last publish attempt failed. An operator must
  learn about a failed publish **without** opening the tab; today the alert is
  in the panel they are not looking at.
- Nested tabs: `PlanCatalogTabs` lives inside Browse. Both `SurfaceTabs`
  instances need distinct `label`s or the tablists are ambiguous to a screen
  reader.
- State stays local, per `SurfaceTabs`' own comment: the page already owns
  `?mode=` and a second query param would collide.

**Done when:** render tests assert both panels reachable, the count badge
reflects changed rows, a failed attempt marks the tab, and the two tablists have
distinct accessible names. `page.test.tsx` still passes.

### T3 — Search across the 42 lookup keys

A `SearchFilterInput` in both Browse and Draft & Publish, matching
case-insensitively against lookup key, plan and currency.

- Filters the rendered rows only. It must never change what is published, and
  must never change the rail's counts — a hidden changed row is still a changed
  row, and a search that quietly shrank "12 changed" to "2 changed" would be the
  worst possible bug on this screen. Assert that explicitly.
- Empty result gets a real empty state, not a blank panel.

**Done when:** tests cover match by lookup key, by plan, by currency, no-match
empty state, and — the load-bearing one — that rail counts are unchanged by a
search that hides changed rows.

### T4 — The sticky publish rail

In Draft & Publish, the publish summary moves from below the editor to a sticky
right rail: intended vs correcting-drift counts, the changed-row list, and the
Review/Publish action.

- Two-column at wide widths, rail collapsing under the editor below the
  breakpoint. The rail must not be the only route to publishing on a narrow
  viewport.
- `position: sticky` within the panel, not `fixed` — the console has a rail and
  a header of its own to sit inside.
- The live-mode banner and the failed-attempt alert stay above the split, full
  width. A live-mode warning must not be scrollable-past inside a column.

**Done when:** render tests cover the counts, the changed list, and that the
publish action is reachable at both widths; `pnpm --filter console build`
passes.

## Verification for every task

```
pnpm --filter console test:unit
pnpm --filter console typecheck
pnpm --filter console lint
pnpm --filter console build      # not optional — see constraints
```

## The check I owe this branch at the end

The prototype is a mock with invented numbers. The console reads real ones. Before
opening the PR, run the page against dev data and confirm the strip's summary
matches what `readWindowStatus` actually returns for the current window, rather
than matching the prototype's hardcoded "7/7 days clean". Five premises in this
milestone were false because they were read from a document instead of the system.
