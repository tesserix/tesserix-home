---
id: 260905-vd1
slug: opportunity-void
date: 2026-09-05
issue: "#251 — replacing the hard delete shipped in #576"
kind: quick
---

# Void an opportunity instead of destroying it

#576 shipped a hard delete. The issue owner argued on #251 for a void state,
and they are right. Nothing has used the delete — zero `crm.opportunity.delete`
audit rows, zero orphaned activities — so this is a clean replacement, not a
migration of live data.

## Why void wins, including the argument neither side made

- **Three destructive paths with different intents is one too many.**
  `eraseContact` answers "forget me" (DPDP); the organisation cascade answers
  "this business should not be here". "This deal was a mistake" is a third
  intent, and the erasure design depends on that distinction staying sharp.
  Erasure stays the only thing that destroys.
- **The funnel's partition key.** This is the decisive one. `0048` made
  `crm_activities.opportunity_id` `ON DELETE SET NULL`, so a deleted deal's
  `stage_change` rows survive — with a NULL `opportunity_id`. A time-in-stage
  query partitions those rows BY `opportunity_id`, and org-level activities
  (`crm-outreach.ts:274`, `crm-writes.ts:634`) legitimately carry NULL there.
  So the surviving rows become permanently indistinguishable from org-level
  noise. The delete did not remove the history; it removed the history's
  meaning. A void loses nothing — row, FK and parent all survive.
- **Restorable**, which a delete can never be.

## The objection that does NOT evaporate

I told the user most of my earlier cost objections were specific to making
`void` a `crm_stage` enum value and vanish under a `voided_at` column. Four do.
**The fifth does not.**

`crm_opp_product_required_when_qualified` is `CHECK (stage IN ('new','contacted')
OR product IS NOT NULL) NOT VALID` (`0021:114-118`). `NOT VALID` skips only the
initial scan — Postgres re-evaluates it on the new row of **every UPDATE**. A
`DELETE` does not evaluate CHECKs, which is exactly why the hard delete was
immune and why `crm-opportunity-delete.integration.test.ts:140` could bank on
"a product-less mis-click is deletable".

A void is an UPDATE. So:
- The **primary case is safe**: a mis-clicked duplicate is `stage='new'`, and
  the CHECK's first disjunct holds.
- The **~155 grandfathered rows** at `qualified`/`won`/`lost` with a null
  product (`0021:4-6`) would raise a raw 23514. Those are precisely the rows an
  operator most wants to void.

**Resolution: guard, do not migrate.** Copy `setNextAction`'s existing pattern
(`crm-repo.ts:975-977`) — `SELECT … FOR UPDATE`, then
`requiresProduct(current.stage) && !current.product` → `MissingProductError`,
which the console already renders via `mapMissingProduct`. The grandfathered
rows stay un-voidable as a **visible, typed refusal** rather than a raw error.
Backfilling product across 155 rows to validate the constraint is a real data
migration and is not worth it here.

Restore is the same UPDATE and hits the same wall — and is automatically
consistent, since a row that could not be voided cannot be in the voided set.

## What is NOT needed, corrected from my earlier claim

**No index work.** `crm_opp_due_idx` and `crm_opp_drifting_idx` (`0019:131-136`)
are partial on `stage NOT IN ('won','lost')`. Adding `AND voided_at IS NULL`
NARROWS the query's row set, so the query predicate still implies the index
predicate and both indexes remain eligible unmodified. No rebuild, no REINDEX,
and **no new index on `voided_at`** — `driftingOpportunities` (`:543-547`) and
`closedOpportunities` (`:670-675`) both already decline index work at this size
and adding one here would contradict them.

**No Go blocker.** `stage` keeps a known enum value, so `domain.ParseStage`
(`queue.go:128-133`) is unaffected — the enum design's 500 does not exist here.
The Go predicates would simply keep returning a voided row: a visible stale row,
not an outage. And `PLATFORM_API_ORIGIN` is unset in production
(`platform-api/README.md:241-243`), so the queues are served by `crm-repo.ts`
today and no operator can even see it. **T6, separate PR.**

**Keep migration `0048`.** It is already applied. `contact_id` beside it was
already `SET NULL` (`0019:148`), and `0019:141-146`'s header says an activity is
"attached to the organisation, optionally scoped to a deal", which `CASCADE`
contradicted. Reverting would spend a hand-applied production migration to make
the schema worse and re-falsify that header.

## Tasks

### T0 — migration `0049`

`voided_at timestamptz`, `voided_reason text`, and
`CHECK (voided_reason IS NULL OR voided_at IS NOT NULL)` so a reason cannot
outlive a restore. Two nullable columns, no default, no backfill, no rewrite.

**No index, and no touch to the two partial indexes** — the header must say why,
citing the implication argument above, so nobody re-litigates it. The header
must also record the `0021` CHECK interaction, so the next reader does not
rediscover it in production.

Hand-apply to production before merge.

### T1 — revert the destructive path

Delete: `deleteOpportunity`, `DeletedOpportunity`,
`OpportunityActivityTrailUnsafeError`, the `pg_constraint` pre-flight guard, the
`FOR UPDATE OF o` block, `deleteOpportunityAction`,
`mapOpportunityDeleteFailure`, `DeleteOpportunityButton` and its dialog, and
`crm-opportunity-delete.integration.test.ts`. Restore `crm-erasure.ts`'s header
to describing two operations.

Retain and repoint: `opportunityProductLabel`, the "say what survives" copy
discipline, the untyped confirm dialog and its rationale, the audit target shape
`"Org — product (id)"`, the `revalidatePath` pair.

Keep `crm-activities-opportunity-fk.integration.test.ts` as a **schema-invariant**
test, retitled off "on opportunity delete", with its two raw-DELETE demo cases
stripped to the constraint assertions.

Its own commit, so the diff reads as a revert.

### T2 — `voidOpportunity` / `restoreOpportunity`

New `lib/db/crm-void.ts` — **not** `crm-erasure.ts`; the whole point is that a
void is not an erasure, and that file's header says it holds destructive
operations.

One `tesserixTx` each; `SELECT … FOR UPDATE`; the `MissingProductError` guard
above; an already-voided / already-live no-op distinguished the way
`AdvanceStageResult` (`:744-748`) distinguishes its own; `updated_at = now()`
written by hand (`crm_opportunities` has no trigger, `:955`).

Both write a `crm_activities` row **in the same transaction**, `kind: 'note'`
with structured `metadata` — the precedent is `advanceStageOnQuery`'s
product-change note (`:900-914`), which uses `'note'` precisely because it is
not a stage change. **Never `stage_change`**: that kind carries `{from,to}` and
is the funnel's source of truth, so a void written as one would inject phantom
transitions into the aggregate this design exists to protect. Adding a `void`
kind is an `ALTER TYPE` on a closed enum and is not worth it.

### T3 — the predicates. Highest risk; most of the review attention goes here.

Mechanical, `AND voided_at IS NULL`:
1. `dueOpportunities` `:520`
2. `driftingOpportunities` `:565`
3. `CLOCK_ELIGIBLE_SQL` `:1148-1149` — both call sites (`:1185`, `:1195`); the
   by-organisation branch matters most, since an org-level note today bumps
   every open deal's clocks and would resurrect a voided one
4. `recordTemplatedDm`'s clock UPDATE — free, it imports the constant
5. `listOrganisations` `open_opportunities` `:3307-3309`
6. `closedOpportunities` `:691` — exclude: a void says the deal should never
   have been counted, and leaving it on Closed reintroduces the close-rate
   pollution that motivates the whole issue
7. `wonWithoutConversion` `:2606-2618` — exclude

**New behaviour, not a predicate edit** — these were missed in my first pass:
8. `linkConversion`'s won-deal lookup `:2748-2753` and its product-backfill
   UPDATE `:2791-2801`. **A data-corruption path**: it selects by
   organisation+product, not off the handoff row, so a voided won deal can
   absorb a conversion — stamping `converted_ref` on the organisation and then
   permanently blocking the real deal via `AlreadyLinkedError` (`:2670`).
9. `setNextAction` `:958-990` — typed refusal on a voided deal, beside the
   existing `MissingProductError` check, from the same `FOR UPDATE` read.
10. `advanceStageOnQuery` `:827-914` — refuse moving a voided deal, or "void
    then move to won" yields a won-and-voided row every predicate must reconcile.

Deliberately unchanged: `organisationDetail`'s opportunity list and timeline —
the detail page is the organisation's file, a voided deal stays visible there
rendered as voided, or restore has no affordance. Same reasoning the file
already applies to erased contacts (`:1496-1502`).

Predicate changes need **integration** coverage; `page.test.tsx` mocks the repo
and will not catch a missed site.

### T4 — the actions

`voidOpportunityAction` / `restoreOpportunityAction` via `withCrmWrite`; audit
`crm.opportunity.void` / `.restore` (`validateActionName` is a format check, not
an allowlist). Summary `{ voided: 1 }` — a void has no collateral to count.

**Gate on `crm`, not `hard-delete`.** A void destroys nothing and is reversible;
`actions.ts:1318-1322` already draws exactly this distinction for another
ordinary correction. `canHardDelete` stays threaded for the erase and
organisation-delete controls; the void simply stops consuming it.

### T5 — the control

Void button + confirm on the opportunity card, a voided badge, and a Restore
affordance on a voided card. Port the six render tests from the delete control.

## Out of scope

T6 (the Go predicates) ships separately, with a note in
`docs/PLATFORM-API-CONVENTIONS.md` §10 so the `PLATFORM_API_ORIGIN` cutover
checklist owns it. The `owner` half of #251 is untouched — it needs #244.

## Where this bites if rushed

T3 site 8 (`linkConversion`) and the `0021` CHECK in T2. Both are silent — no
test fails, no error surfaces, and an operator finds out. Both get a second
reader.

## Verification

From the WORKTREE root (`pnpm --filter console` from the primary checkout tests
the primary checkout and reports green against code without the change):

    pnpm --filter console lint
    pnpm --filter console typecheck
    pnpm --filter console test:unit
    pnpm --filter console build
