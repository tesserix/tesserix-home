---
slug: kora-food-row-detail
date: 2026-08-27
mode: quick
---

# Kora food rows: expandable detail + pager placement parity

Two changes to the console's Kora surfaces. Console-only. No new route, no new
fetch, no contract change.

## Change A — expandable food rows (`kora/foods/food-index.tsx`)

**Why this shape.** Food rows are not clickable and there is nowhere to click
to: the console reads foods through `GET /v1/entities/{type}`
(`lib/platform-api.ts:817`), and platform-api registers that list pattern only
(`platform-api/internal/modules/entities/internal/handler/handler.go:46`).
There is no get-one at any layer, so a `/kora/foods/[id]` route would be a URL
with nothing behind it. The whole record the console can hold is the six fields
of `EntityRecord` (`lib/entities.ts:14`) — three of which the table already
shows. Expanding in place shows the other three honestly, without implying a
detail page exists.

**What to build.**
- Each food's label becomes the disclosure trigger: a `<button>`, not a row
  `onClick`. A row-level click handler is unreachable by keyboard and invisible
  to a screen reader.
- `aria-expanded` on the trigger, `aria-controls` pointing at the detail row's
  `id`. Ids must be derived from the record id so two expanded rows never
  collide.
- The detail renders as a second `<TableRow>` with `colSpan={2}`, revealing
  `id`, `source`, and `type` as labelled pairs. Only rendered while expanded.
- Expansion state: `useState` holding a `Set<string>` of expanded ids. Per the
  repo's immutability rule, toggling constructs a NEW Set — never `.add()` on
  the held one.
- State is per-render and deliberately NOT in the URL: it is a peek at a row,
  not a location, and putting it in the query string would collide with the
  pager's params.
- `sublabel` keeps its existing rule — rendered only when present, never
  replaced by a placeholder, because absent is a legitimate shape (§3.4 does
  not define the row; see #365).

**Scope.** Foods only. `kora/users/user-directory.tsx` carries the same six
fields and the same argument, but the request was foods; do not change its
rows.

## Change B — pager above the table, both Kora surfaces

The two CRM surfaces render `ResultPager` ABOVE their table/list
(`platform/crm/queue-view.tsx:97`, `platform/crm/organisations/organisations-view.tsx:172`).
Both Kora surfaces render it below. Move Kora's to match — this is the
majority convention and the one the user asked for.

- `kora/foods/food-index.tsx`: order becomes FilterBar → ResultPager → Table →
  scopeNote.
- `kora/users/user-directory.tsx`: same move.
- `ResultPager` itself is unchanged; so is the `scopeNote`, which stays last
  because it describes the result set rather than the controls.

## Tests

- New `kora/foods/food-index.render.test.tsx`, following the
  `components/kit/result-pager.render.test.tsx` convention (vitest +
  @testing-library/react).
  - collapsed by default: `id`/`source`/`type` are not in the document
  - activating the trigger reveals them; activating again hides them
  - `aria-expanded` tracks state and `aria-controls` resolves to the revealed row
  - two rows expand independently — expanding one does not collapse the other
    (this is what catches a mutated Set)
  - a row without `sublabel` renders no placeholder
- A placement assertion for Change B on both surfaces: the pager precedes the
  table in DOM order. Write it as a statement that fails if the order flips
  back, not as a snapshot.
- Existing `foods/page.test.tsx` and `users/page.test.tsx` must still pass
  untouched.

## Verification

- `pnpm test` in the console workspace.
- Rebuild `console-core` before app tests — it ships via `dist`, so the app
  otherwise tests a stale bundle.
- `next build` for the console. tsc is not a build: a client component pulling
  a value from a module with server ancestry drags `pg` into the browser
  bundle while tsc and vitest both pass. This change imports nothing new from
  `lib/`, but the build is the only thing that proves it.

## Out of scope

- Any get-one endpoint, in kora or platform-api. That is a contract gap
  (sibling to #365) and belongs in its own session; file nothing in kora.
- `/kora/foods/[id]` as a route.
- Users rows getting the same disclosure.
