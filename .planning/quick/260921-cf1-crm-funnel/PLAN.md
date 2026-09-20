---
id: 260921-cf1
slug: crm-funnel
date: 2026-09-21
kind: quick
branch: feat/250-crm-funnel
issue: 250
---

# The funnel is already being recorded and nothing reads it

`advanceStage` writes a `crm_activities` row inside the same transaction as
every stage change — `kind = 'stage_change'`, `metadata = {from, to}`,
`occurred_at`, `actor` — so a stage cannot move without its record. Verified
on `origin/main` @ 2a47d0f that **no application query selects
`crm_activities.metadata`**: the only `SELECT … metadata` hits in
`apps/console` are in `*.integration.test.ts`, asserting on what was written.
The richest structured data in the schema is written faithfully and read by
nothing.

`/platform/crm` has three tabs — Work, Handoff, Closed — and none of them
states a count, a rate or a duration.

## What this adds

A fourth tab, **Funnel**, on `/platform/crm`.

A tab and not a band on the Work tab, for the reason `tabHref`'s comment
already records: these tabs are real navigation, and only the active tab's
data is ever read. A band on Work would make every visit to the follow-up
queue pay for an aggregate nobody asked for. Handoff's fan-out is the
precedent this file's comment was written for.

## Two reads, and why each is honest today

**1. Counts by stage.** Straight off `crm_opportunities.stage`, one
`GROUP BY`, excluding voided deals via `notVoided` — the same exclusion
`closedOpportunities` applies, and for the same #251 reason: a deal an
operator has said should never have been in the funnel must not be counted
in the shape of the funnel. Rendered with `components/kit/ranked-bars.tsx`,
the precedent the tickets analytics panel set.

**2. Time in current stage.** The operational signal the issue names: a lead
sitting in `contacted` for sixty days is the thing worth surfacing, and
nothing surfaces it. Computed as `now() - ` the `occurred_at` of the deal's
most recent `stage_change` activity, falling back to `created_at` for a deal
that has never moved.

The fallback is what makes this read non-empty on day one. Every production
opportunity is `stage = 'new'` with no transitions at all, so a measure
defined purely over transitions would render empty until the CRM is actually
worked. "How long has this deal sat where it is" is answerable for a deal
that has never moved — that is exactly the deal worth asking about — and the
fallback to `created_at` is the same one `quietSince` already makes in the
drifting query.

Open stages only. "How long has this won deal been won" is not a question.

## What is deliberately NOT in this change

**Average time-in-stage across transitions** (the historical measure, as
opposed to the current one above) and **per-stage conversion rate** both
require a population of `stage_change` rows that does not exist yet — today
every production opportunity is `new` with zero transitions, so both would
render a confidently empty panel. They become answerable as soon as the CRM
is worked, and the read for them is the same `metadata` this change opens up.
Recorded here rather than built, so the next person knows they were weighed.

**Won-share of closed deals** is free from read 1 (`won / (won + lost)`), but
a single rate over all deals ever, with no cohort and no time bound, is the
kind of number that gets quoted and is wrong. The counts are stated; the
reader can divide, and can see the denominator while doing it.

## Tasks

1. **`lib/db/crm-funnel-repo.ts`** — `funnelSummary()` returning the stage
   counts and the stalled-deal rows. Excludes voided via `notVoided`; uses
   `tesserixQuery`. Re-exported from the `crm-repo.ts` barrel in the named
   style that file requires. Unit tests against a stubbed query, plus an
   integration test that proves the `created_at` fallback and the voided
   exclusion.

2. **`app/(console)/platform/crm/funnel-tab.tsx`** — `renderFunnelTab`, a
   plain awaited function (not a nested async component) for the testability
   reason `renderWorkTab` records. Error goes through `dbReadError`, state
   through `resolveState`, exactly as `renderClosedTab` does.

3. **Wire the tab** — `CrmTab` gains `"funnel"` in `url.ts`, `readTab`
   admits it, `CrmTabNav` lists it, `CrmPage` dispatches to it. Render tests
   asserting the tab is reachable and that the other three are unchanged.

## Done when

- `/platform/crm?tab=funnel` states a count for every stage and lists the
  deals that have sat longest where they are.
- A voided deal appears in neither number.
- A deal that has never changed stage still reports a time in stage.
- The Work, Handoff and Closed tabs read exactly as they did.
- `pnpm test:unit`, `typecheck` and `lint` green in `apps/console`.
