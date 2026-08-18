# A Previous control for every paged CRM surface

Reported alongside the Drifting cap (#240): paging forward works, but there is
no way back except the browser's own button.

## Where #240 left things

- `encodeKeysetCursor` / `decodeKeysetCursor` in `crm-repo.ts` — a shared,
  deliberately **direction-free** codec over `(timestamp, uuid)`.
- `queuePage` — one ascending implementation serving Due and Drifting.
- `listOrganisations` — its own descending implementation.
- `components/kit/result-pager.tsx` — already accepts an optional
  `previousHref` and renders a Previous control when given one. **No caller
  passes it yet.** That is the gap this closes.

So the UI half is built and tested. This PR is the cursor work behind it.

## The core change

A cursor today anchors on the page's **last** row and always advances with the
sort direction. Paging backwards needs the mirror image:

- anchor on the page's **first** row,
- flip the comparison (`<` ⇄ `>`),
- flip the `ORDER BY`,
- `LIMIT n + 1` as usual to prove a *previous* page exists,
- then **re-reverse the rows in TypeScript** before returning, so the caller
  always receives them in display order.

That last step is the one that is easy to get wrong and invisible in a small
fixture: fetched backwards, the rows arrive in reverse display order. A test
must assert the returned order directly, not merely the set of ids.

The direction has to travel in the URL, so it must be encoded in the cursor
rather than passed as a separate param — otherwise a shared or reloaded link
loses it and silently renders the wrong page. Extend the codec to carry a
direction while keeping it honest: it may describe *which way this cursor
points*, never assume a sort order it cannot know.

## Both surfaces, one shape

`listOrganisations` (descending) and `queuePage` (ascending) both need it.
Keep the existing split — one ascending implementation, one descending — and
do not merge them behind a direction flag. #240 rejected that for a reason
worth preserving: a helper taking a direction argument cannot be read without
also finding its caller.

Each page type gains a `previousCursor: string | null`, null on page one.

`precedingCount` already tells the surface where it is, so a Previous control
can be labelled correctly with no extra query.

## Wiring

- `organisations/page.tsx` — a `buildPreviousHref` mirroring `buildNextHref`,
  and `previousHref` threaded into `OrganisationsView` → `ResultPager`.
- `crm/page.tsx` + `queue-view.tsx` — the same for `dueCursor` and
  `driftCursor`, each still replacing only its own param.
- A filter change must keep dropping every cursor, exactly as now.

## Two follow-ups from #240, both in scope here

**1. `useQueueUrlFilters` duplicates `useOrganisationUrlFilters`.** They differ
only in dropping a set of params rather than one. #240 could not merge them
because the two files were owned by different agents. Extract one shared hook
taking the params to drop, and delete both copies.

**2. `dbReadError` says "try again shortly" for a malformed cursor.** A retry
can never fix a hand-edited `?cursor=`. Both surfaces share this, which is why
#240 left it rather than inventing one-off copy. Fix it once, in the shared
error path: a bad cursor should tell the operator the link is not valid and
offer the unparameterised surface, not invite a pointless retry.

Do not let this widen into a general error-copy rewrite — only the
malformed-cursor case changes.

## Verification

- **Order, not just membership**: paging back from page 3 to page 2 returns
  page 2's rows *in display order*. A set-equality assertion passes even when
  the re-reverse is missing, so assert the sequence.
- **Round trip**: forward to page 3, back to page 1, and the rows equal the
  original page 1 exactly.
- **Boundaries**: `previousCursor` is null on page one, `nextCursor` null on
  the last page, and a single-page result offers neither.
- **Ties**: the fixture must keep #240's tied-timestamp shape — a tie-break
  bug shows up backwards even when forwards looks correct.
- Mutation-test each guard, the re-reverse included.

## Gates

`pnpm --filter console test:unit`, `typecheck`, `lint`, `build`. No new
dependencies. Nothing under `apps/web` or `/admin/`.
