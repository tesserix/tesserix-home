# The Drifting queue hides 159 organisations

## The defect

`driftingOpportunities` takes a `limit` and returns a bare `QueueRow[]` — no
total, no cursor. `apps/console/app/(console)/platform/crm/page.tsx` passes
`DRIFTING_LIMIT = 100`.

Production holds **259 organisations, every one of them in Drifting**: the
leads migration left `next_action_at` NULL on all of them and preserved a
`created_at` old enough to clear the 14-day threshold.

So the queue renders 100 rows and silently discards 159. There is no count, no
"showing 100 of 259", no truncation notice — nothing an operator could read as
"there is more". Someone working that queue to the bottom reasonably concludes
they have seen every organisation.

That is the same defect class this codebase has been sweeping all session: a
surface that reports success while withholding the truth. It is a
data-visibility bug first and a pagination feature second, and the honest count
matters more than the paging.

`dueOpportunities` is structurally identical and differs only in its predicate.
It does not bite today solely because every production row has a NULL
`next_action_at`, so Due is empty. Fix both — the second one is a latent
instance of the same bug, not a hypothetical.

## A correctness trap in the current ordering

Neither queue has a deterministic sort:

```sql
ORDER BY COALESCE(o.last_contacted_at, o.created_at) ASC   -- drifting
ORDER BY o.next_action_at ASC                              -- due
```

No tiebreak. Rows sharing a timestamp order arbitrarily, which is harmless for
a single capped page and **fatal for keyset pagination** — a row can repeat on
one page and vanish from another. Every one of the 259 migrated rows shares a
narrow timestamp range, so this is likely, not theoretical.

Both need `, o.id ASC` appended before any cursor work. Add the tiebreak first
and pin it with a test that fails without it.

## Scope, and what is deliberately deferred

This PR: **honest counts and forward pagination for both queues**, plus the
shared pager the estate currently lacks.

A "previous" control is the *next* PR, because it needs a bidirectional cursor
in `listOrganisations` too and belongs with that change. So the kit pager
introduced here takes an **optional `previousHref` from the outset** — the next
PR supplies it and no caller changes shape.

Not in scope: the follower/country filter honesty work (a third PR), and
anything under `apps/web` or `/admin/`, which stay untouched.

## Task A — the repository layer

`apps/console/lib/db/crm-repo.ts`.

1. Add `, o.id ASC` to both queue orderings. Pin with a test over rows sharing
   a timestamp that fails on the unsorted version.
2. Give both queues the shape `listOrganisations` already uses — return
   `{ rows, total, precedingCount, nextCursor }` rather than a bare array.
   Follow `listOrganisations` (`crm-repo.ts:2045-2139`) closely: concurrent
   count + page queries, `limit + 1` to prove a next page, `count(*) FILTER
   (WHERE …)` for `precedingCount`.
3. Cursor encoding: the queues sort **ascending** on a *different* column than
   the browse surface, so `encodeOrganisationCursor` cannot be reused as-is.
   Write a queue cursor over `(sortKey, id)` where `sortKey` is
   `COALESCE(last_contacted_at, created_at)` for drifting and `next_action_at`
   for due. Validate on decode exactly as the organisation cursor does, and
   reject a malformed one rather than silently returning page one.

   **Do not paper over the asymmetry** — if a shared helper genuinely fits both
   orderings, extract one; if it does not, keep them separate and say why in a
   comment. Do not force a shared abstraction that has to lie about direction.

`total` must be the **unlimited** count for the queue's own predicate and
filters, since it is the number the operator is being told about.

## Task B — extract the pager into the kit

`ResultCount` is local to `organisations-view.tsx:220-235`. The queues use a
different component tree entirely (`queue-view.tsx` → `components/kit/queue-list.tsx`),
so there is no shared control and the two surfaces have already diverged.

Move it to `apps/console/components/kit/` as a proper kit component:

- Props: `rows`/`count`, `total`, `precedingCount`, `nextHref`, and an
  **optional `previousHref`** (rendered only when supplied — nothing passes it
  yet).
- Keep the existing behaviour exactly: the `{first}–{last} of {total}` range,
  `aria-live="polite"`, and `Next` as a real `<Link>` so browser Back keeps
  working. That `<a href>` choice is deliberate — `organisations-view.tsx:209`
  documents it — so preserve it and the comment's reasoning.
- `organisations-view.tsx` then imports it. **This half is a pure refactor:**
  its existing tests must pass untouched. If a test needs editing to stay
  green, the refactor changed behaviour and is wrong.

## Task C — wire the queues

`apps/console/app/(console)/platform/crm/page.tsx`, `queue-view.tsx`.

- Read a per-queue cursor from the URL. Due and Drifting render on the same
  page, so they need **distinct params** (e.g. `dueCursor`, `driftCursor`) or
  paging one will reset the other.
- Thread `total`/`precedingCount`/`nextHref` into `CrmQueueView` and render the
  kit pager in each section's header.
- A filter change must drop the queue cursors, exactly as the browse surface
  drops `cursor` (`organisations-view.tsx:61`) — a stale cursor against a
  narrowed result set lands on an empty page.
- The empty state must still win when a queue is genuinely empty: "0 of 0" with
  a pager is worse than the existing empty message.

## Verification that actually matters here

The bug is invisible below 100 rows, so a test with three fixtures proves
nothing. Integration tests must **seed more than one page** — at least
`limit + 1` rows, ideally a shape mirroring production (all rows drifting, tight
timestamp spread) — and assert:

- `total` reports every matching row, not the page size.
- The last row of page one does not reappear on page two, and no row is skipped
  between them (the tiebreak regression).
- Paging through to the end yields exactly `total` distinct rows.

Mutation-test every guard, including the `, o.id ASC` tiebreak.

## Gates

`pnpm --filter console test:unit`, `typecheck`, `lint`, `build`. No new
dependencies.
