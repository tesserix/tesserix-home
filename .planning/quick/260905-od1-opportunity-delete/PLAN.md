---
id: 260905-od1
slug: opportunity-delete
date: 2026-09-05
issue: "#251 (the disposal half)"
kind: quick
---

# An opportunity can be deleted, and a worked deal keeps its trail

An opportunity has no delete of any kind. Clicking "New opportunity" twice
leaves a permanent duplicate whose only disposal is marking it `lost` — which
requires inventing a `lost_reason` and then pollutes every close-rate and
loss-analysis number the funnel work would compute. A mis-click becomes
indistinguishable from a real loss, forever.

## Delete, not a `void` stage — and this reverses what I first proposed

`void` looked cheaper than it is. Research established:

- **`crm_stage` is a Postgres ENUM** (`0019_crm_schema.sql:12`), so it needs
  `ALTER TYPE`, whose new value cannot be used in the same transaction.
- **The product CHECK would refuse the very row this issue is about.**
  `crm_opp_product_required_when_qualified` is `stage IN ('new','contacted') OR
  product IS NOT NULL`, and `NOT VALID` only skips the initial scan — Postgres
  still evaluates it on every UPDATE's new row. A mis-clicked duplicate has a
  NULL product, so `SET stage='void'` would fail with a raw constraint
  violation. That is a second migration.
- Both partial indexes (`crm_opp_due_idx`, `crm_opp_drifting_idx`) name
  `stage NOT IN ('won','lost')` and would need rebuilding.
- **It would take the live Due queue down if deployed out of order.**
  `platform-api`'s `scanOpportunity` calls `ParseStage` on the way OUT of the
  database and errors on an unknown value, and the Go queue predicates exclude
  only `won`/`lost`. The first voided row with a due next action makes the whole
  Due queue error, not degrade. Go would have to ship and be fully rolled out
  first — a one-way door.
- 14 console call sites enumerate or special-case the stage set, only two of
  which (`STAGE_LABELS`, twice) the compiler catches.

Delete achieves the same thing for the loss statistics — **a deleted row
pollutes a close rate exactly as little as a void one** — with no migration on
the enum, no Go release, and a precedent already in the codebase.

## The precedent to copy, exactly

`deleteOrganisation` (`lib/db/crm-erasure.ts:358-390`) and
`deleteOrganisationAction` (`[organisation]/actions.ts:653-681`):
`withCrmWrite` with `{ capability: "hard-delete" }`, one `tesserixTx`, an audit
row (`crm.organisation.delete`) carrying counts, `mapDeleteAuditFailure` for
post-commit audit failure copy, and a typed-confirmation
`DestructiveConfirmDialog` gated on `hasCapability(session?.roles,
"hard-delete")` (`[organisation]/page.tsx:91`).

## Tasks

### T1 — keep the activity trail: `ON DELETE SET NULL`

`crm_activities.opportunity_id` is `ON DELETE CASCADE` (`0019:141`). A deal
worked for three DMs and then found to be a duplicate would take its whole
history with it — the one case a `void` state would genuinely have served.

The column is **already nullable**, and `0019:143-146`'s own header says an
activity is "attached to the organisation, optionally scoped to a deal". So
`SET NULL` is what the schema already describes; `CASCADE` contradicts it.

New migration: drop and re-add the FK as `ON DELETE SET NULL`. No data change.

**This migration must be applied to production BEFORE its PR merges** —
deploys are automatic here and `db:migrate` does not ride along.

### T2 — the repo function and the action

- `deleteOpportunity(opportunityId)` in `lib/db/crm-erasure.ts`, modelled on
  `deleteOrganisation`: one `tesserixTx`, returns counts (activities detached,
  not deleted, after T1).
- `deleteOpportunityAction` in `[organisation]/actions.ts` via `withCrmWrite`
  with `{ capability: "hard-delete" }`, audit action
  `crm.opportunity.delete`, target naming the organisation and the product so
  the audit row is readable without a join.

Done when: an opportunity can be removed, the organisation's other
opportunities and contacts are untouched, and its activities survive on the
organisation timeline with a null `opportunity_id`.

### T3 — the control

A destructive confirm on the opportunity card
(`organisation-detail-view.tsx`), reusing `DestructiveConfirmDialog` and the
`canHardDelete` prop already threaded through `[organisation]/page.tsx:91`.

**It must not be a fourth option in the stage `<select>`.** That control is
`CRM_STAGES.map(...)` and a mis-click landing on a destructive option is the
hazard this issue exists to remove, not one to add.

## Out of scope

The rest of #251 — `owner` being write-once and free-text, `source`
unsettable, `is_starred` unwritable. `owner` needs the identity model (#244)
settled first, and this issue's own scope section says so.

## Verification

From the WORKTREE root (`pnpm --filter console` run from the primary checkout
tests the primary checkout and reports green against code without the change):

    pnpm --filter console lint
    pnpm --filter console typecheck
    pnpm --filter console test:unit
    pnpm --filter console build

Integration tests run on pglite, so T1's migration is exercised there too.
