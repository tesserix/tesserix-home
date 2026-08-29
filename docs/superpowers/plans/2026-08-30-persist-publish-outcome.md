# Persist the publish outcome across a reload, and stop hiding orphans

**Issue:** tesserix-home#410
**Branch:** `feat/persist-publish-outcome`
**Base:** `c8d2fee` (#435, which merged #409's refused-mutation audit row)
**Date:** 2026-08-30

---

## Why this is worth doing now

#327 — lift the live-publish refusal, provision `STRIPE_WRITE_KEY_LIVE` — is the last
console blocker on mark8ly's billing milestone, and its checklist ends with "first live
publish as a dry-run diff". Whoever runs that reads the outcome on screen. Today that
outcome exists only in React state set by `publishAction`'s return value, so it survives
exactly one page load.

#409 (merged as `c8d2fee`) made a *refused* publish write an audit row, which does survive
a reload — but `AuditSummary` has nowhere for rows to go, so that row deliberately cannot
carry the orphan list. **The audit row survives and lacks the orphans; this surface has the
orphans and does not survive.** Neither substitutes for the other, which is why this is a
separate piece of work rather than an extension of #409.

## The orphan-blindness claim, verified

The issue's priority rests on a claim about `parity.ts`. It is **true**, but its stated
mechanism is backwards, and the corrected version is what the code and the copy must
reflect.

- **Issue's wording:** "`parity.ts` skips prices with a null `lookup_key` and a
  transferred-away price *has* one, so parity reports clean."
- **What the code does** (`lib/billing/parity.ts`, the live-price ingest loop):

  ```ts
  for (const price of stripePrices) {
    const key = price.lookup_key;
    if (!key || !key.startsWith(namespacePrefix)) continue;
  ```

  A `replace_price` creates a new Price, moves the key onto it with
  `transfer_lookup_key`, and archives the old id. If that archive never lands, the **old**
  Price is left `active: true` with **no** lookup key — `transfer_lookup_key` moved it
  *away*. So it is the `!key` branch that skips it, not a key-prefix mismatch.

The conclusion is unchanged and the priority stands: the comparator has nothing to join the
orphan against, so a parity run reports `clean` — correctly by its own rules — while an
abandoned Price with a live Subscription on it keeps billing. `orphans.ts`'s module header
already states the mechanism correctly; this plan does not need to change it.

Two corollaries the comparator's other branches might seem to cover, and do not:

- `price_shape_mismatch("active")` cannot fire on an orphan — the orphan never matched a
  `lookup_key`, so it never reaches that branch. It also cannot fire against a live read at
  all today, because `stripe-read.ts` filters to `active: true`.
- `price_missing_in_catalog` cannot fire either, for the same reason: that loop iterates
  the already-keyed `stripe` map.

## What the issue got wrong about the existing code

Two facts discovered while reading, both of which change the work:

**1. There is no "latest attempt for this mode" reader.** The issue says "both readers
exist", naming `publishAttemptById` and `operationsForAttempt`. `publishAttemptById` takes
an **attempt id**, and on page load we do not have one. A new query is required. It is
still not a schema change — `plan_catalog_publish_attempts` (0038) already has `mode`,
`started_at` and `outcome`.

**2. Orphans are not persisted anywhere.** `actions.ts` computes them live:

```ts
const orphans = outcome.outcome === "failed" ? await findOrphans(mode) : [];
```

and returns them in the action result. Nothing writes them to a table. So "read the
attempt back" cannot recover the orphan list — it has to be **re-derived**.

**3. `findOrphans` is mode-scoped, not attempt-scoped.** It cross-references
`archivedStripePriceIds(mode, SINGLE_SOURCE)` — *every* archived id in the log for that
mode — against Stripe's active set. An orphan therefore **outlives the attempt that created
it**, and in particular **survives a later successful publish**.

Fact 3 is what answers the issue's open design question, below.

## The two decisions, and their reasoning

The issue names one open question ("always the most recent attempt, or only while
unresolved") and does not answer it. Answering it properly splits it in two, because
attempt outcomes and orphans have different lifetimes.

### Decision 1 — the attempt outcome is surfaced only while unresolved

Render the persisted outcome **only when the mode's latest attempt is `failed` or
`aborted`**. A `succeeded` latest attempt renders nothing.

Reasoning:

- Success is **already durably surfaced**, by `readLivePublication` → the
  `PUBLICATION_SURFACE` block in `CatalogViews`: who published which revision, and when.
  A persisted success banner would be a second, redundant account of the same event —
  and this page's own conventions (`publish-outcome.tsx`'s "Consistency with
  `publish-view.tsx`" note) treat two accounts of one event as a defect.
- `PublishOutcome`'s success copy is *"Published. Stripe now matches this revision, and it
  is the mode's published catalog."* That is a claim about **Stripe's current state**, not
  a historical record. It is true at the moment of publish and decays silently as the
  catalog drifts. Pinning it above the catalog permanently is the "stale success banner is
  its own bug" case the brief warns about, in its most literal form.
- "Unresolved" needs no extra bookkeeping: because we read only the *latest* attempt, a
  subsequent successful publish resolves a prior failure automatically.

### Decision 2 — orphans are surfaced independently of the attempt, always

Run `findOrphans(mode)` on every page load, in its own independently-narrowed read, and
render the orphan callout whenever it returns a non-empty list — **regardless of what the
latest attempt's outcome was**.

Reasoning:

- Per fact 3, an orphan survives a later successful publish. Gating the orphan check on
  "the latest attempt failed" would mean: publish fails and leaves an orphan → operator
  re-plans and publishes successfully → the orphan becomes **permanently invisible**. That
  is the exact bug this issue exists to fix, reintroduced one level down, and it would be
  worse than the current state because it would look deliberate.
- Nothing else in the estate can see an orphan. The nightly parity check structurally
  cannot (above). This surface is the only one, so it must not make its own visibility
  conditional on an unrelated fact.

The cost is one paged Stripe `prices.list` per catalog page load. Accepted: this is an
internal platform console with a handful of operators, the call is the same one the nightly
parity run already makes, and it is isolated so a Stripe outage degrades to "orphan check
unavailable" without touching anything else on the page.

### Decision 3 — the live session outcome still wins

`AuthoringPanel` keeps its `useState` outcome from `publishAction`. The persisted read is
a **fallback**, not a replacement: `shown = sessionOutcome ?? persistedOutcome`.

This is what makes Decision 1 correct rather than hostile. An operator who has *just*
published successfully sees their success confirmation in that session — they performed the
action and deserve the receipt. On reload it does not come back, because by then
`readLivePublication` is the honest surface for that fact. A failed publish shows in-session
*and* after reload, from two sources that agree.

## Constraint: independent-read narrowing

Non-negotiable, from the issue and from `page.tsx`'s own module header. The page currently
runs five reads through `Promise.allSettled` plus a dependent sixth. This work adds **two
more independent reads** (latest attempt, orphans) and one dependent one (operations for
that attempt). A failure in any of them must narrow into its own `SurfaceState` and must
not take down the catalog table or the observation window.

Note the dependency shape mirrors the existing `readDraft` → `readDraftRows` pair exactly:
operations cannot be read until the attempt read has named an id, so it sits outside the
`allSettled` array in its own `try`/`catch`, precisely as `readDraftRows` does.

---

## Tasks

Each task is TDD: write the failing test first, watch it fail, implement, watch it pass.

### Task 1 — `latestPublishAttempt(mode)` in `publish-repo.ts`

Add a reader for the most recent attempt for a mode, finished or not.

```sql
SELECT id, revision_id, mode, fingerprint, started_by, started_at, finished_at, outcome
  FROM plan_catalog_publish_attempts
 WHERE mode = $1
 ORDER BY started_at DESC, id DESC
 LIMIT 1
```

- Reuses the existing `mapAttemptRow`; returns `PublishAttempt | null`.
- `id DESC` as a tiebreaker so two attempts sharing a `started_at` order deterministically
  rather than by page order — the same reasoning `startPublishAttempt`'s first-wins comment
  applies to duplicate keys.
- Returns an attempt whose `outcome` is still `null` (one genuinely in flight). The caller,
  not this function, decides what to do with that — see Task 4.
- **Test:** extend `lib/db/publish-operations.integration.test.ts` (pglite, per that file's
  existing discipline). Cases: no attempts → `null`; several attempts for the mode → the
  newest; an attempt in the *other* mode → not returned; an unfinished attempt → returned
  with `outcome: null`.

### Task 2 — page-level reads and their narrowing

In `page.tsx`:

- Add `ATTEMPT_SURFACE = "the latest publish attempt"`, `ORPHANS_SURFACE = "the orphaned
  Stripe price check"`, `OPERATIONS_SURFACE = "the publish attempt's operations"`, each with
  its own `*ReadError` narrowing function, matching the existing six exactly.
- Add `readAttempt(mode)` and `readOrphans(mode)` as siblings in the `Promise.allSettled`
  array (now seven).
- Add `readOperations(attemptId)` **outside** the array, in its own `try`/`catch`, gated on
  the attempt read having succeeded and returned an unresolved attempt — the `readDraftRows`
  shape.
- `readOrphans` calls `findOrphans(mode)`. `orphans.ts` is `server-only` and reaches both
  `pg` and `stripe`; this is a server component, so a static value import is correct here —
  the same call `page.tsx` already makes into `server-only` `publish-repo.ts` via
  `currentDraft`. **Do not** let this type or value reach `AuthoringPanel`'s client boundary:
  pass the already-trimmed `PublishOutcomeOrphan` shape, which `publish-outcome.tsx` declares
  precisely so `Orphan` never crosses.
- `readOrphans` needs no `isDatabaseConfigured()` guard of its own beyond the existing
  `notConfigured()` pattern — keep it consistent with the other reads.

**Test:** `page.test.tsx`, mocking `latestPublishAttempt` / `operationsForAttempt` and
`findOrphans`. Prove: a rejected attempt read leaves the catalog table rendered; a rejected
orphan read leaves both the catalog table and the outcome section rendered; a rejected
operations read does not take down the attempt's status line.

### Task 3 — thread the persisted outcome through `AuthoringPanel`

- New optional props: `persistedOutcome` (attempt id, outcome, promoted, operations) and
  `orphans`, plus their `SurfaceState`s.
- `const shown = outcome ?? persistedOutcome` — Decision 3.
- Render the orphan callout on the **union**: the outcome section mounts when there is a
  `shown` outcome **or** a non-empty orphan list. An orphan with no unresolved attempt still
  gets a surface.
- `promoted` for a persisted outcome is `attempt.outcome === "succeeded"`, mirroring
  `actions.ts:712` verbatim rather than deriving it a second way. Under Decision 1 a
  persisted outcome is never `succeeded`, so this is always `false` in practice — write it
  as the mirror anyway, so the two never drift if Decision 1 is revisited.
- Map `PublishOperationRow` → `PublishOutcomeOperation` (sequence, kind, lookupKey, status,
  error). The repo row carries more; the display type is deliberately narrower.

**Test:** `authoring-panel.render.test.tsx` — persisted failed outcome renders after mount
with no session state; session outcome overrides a persisted one; orphans render with no
attempt at all.

### Task 4 — the in-flight attempt case

`latestPublishAttempt` can return an attempt with `outcome: null` — a publish that crashed
between `startPublishAttempt` and `finishPublishAttempt`, which is exactly the crash that
strands an orphan.

Decide and implement: treat `outcome: null` as **unresolved and surfaced**, with copy
distinct from `failed` — the attempt never recorded a verdict, so claiming it "failed" would
assert more than the log knows. `PublishOutcome`'s `outcomeSummary` currently switches on
three outcomes; extend it to handle the null case rather than coercing.

This is not scope creep: it falls directly out of reading a persisted attempt rather than an
action's return value, which is always resolved. `PublishAttemptOutcome | null` is the type
the reader actually returns.

**Test:** `publish-outcome.render.test.tsx` — a null-outcome attempt renders the
in-flight copy, shows its operations, and does not claim promotion.

### Task 5 — full gate run

All four gates, from the worktree root:

```
pnpm --filter console exec vitest run
pnpm --filter console lint
pnpm --filter console exec tsc --noEmit
pnpm --filter console build
```

`build` is not optional here: Task 2 adds an import of `orphans.ts` — which pulls `stripe`
and `pg` — into a module that hands props to a client component. `tsc` and `vitest` both
pass on a server-only leak into the browser bundle; only `next build` catches it. That is
the specific failure mode `lib/money.ts` recorded the expensive way and
`publish-outcome.tsx`'s own header warns about twice.

---

## Out of scope, deliberately

- **Persisting the orphan list to a table.** Re-deriving is *better* here, not merely
  cheaper to build: a stored list would be a snapshot that goes stale the moment someone
  archives the price in Stripe, and would keep showing a resolved orphan until something
  invalidated it. The live check is self-healing.
- **Backfilling `AuditSummary` so the #409 audit row can carry orphans.** That is the other
  half of the pair described at the top, and changing `AuditSummary`'s shape touches every
  audit writer in the console.
- **A "Retry" control.** `publish-outcome.tsx`'s "Re-plan, never retry" section explains why;
  reading an outcome from the database rather than from an action result changes nothing
  about that argument.
