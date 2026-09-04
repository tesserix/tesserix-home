---
id: 260904-x7a
slug: crm-organisations-sort
date: 2026-09-04
issue: "#252 §J (no sort control on the organisations list)"
kind: quick
---

# Sort the CRM organisations list, by followers and name

`/platform/crm/organisations` is fixed `created_at DESC` with no control. #563
just added a Followers column — the only quantitative qualification signal in
the CRM — and you cannot order by it, which is most of its value.

## Two things research disproved before a line was written

**There is no server-driven sort convention to adopt.** `ConsoleDataTable`
ships a complete sort UI — `SortSpec`, `nextSort`, `aria-sort`, a
`SortIndicator` (`components/kit/console-data-table.tsx:23-30, 102-117,
256-295`) — and it has **zero** production consumers. Its only user,
`billing/catalog/publish-outcome.tsx:300-327`, passes no `sort`, no
`onSortChange`, no `sortable` column, and hardcodes `page={1}`. `sortable: true`
appears exactly once outside the component: its own test fixture. So we are
*inventing* this convention, not following one, and everything server-side —
URL param, allow-list, ORDER BY, paging — is new either way.

**Offset paging is the MAJORITY pattern here, not the exception.** `pagerLinks`
(`components/kit/entity-page.ts:85-99`) drives five surfaces — kora/foods,
kora/users, kora/ai-metrics, `[product]/[entity]`, and onboarding/sessions.
Keyset drives two: `listOrganisations` and `queuePage`. `entity-page.ts:3-9`
calls offset *"Paging shared by every §3.4 index surface."*

## The decision: offset when sorted, keyset when not

`listOrganisations` keeps its cursor for the default `created_at DESC` view —
every existing shared link keeps working and every backwards-paging test keeps
passing. When a `?sort=` is present, the surface pages by `?page=` offset
through the existing `pagerLinks`.

`ResultPager`'s props are identical under both regimes (`result-pager.tsx:9-29`
against `entity-page.ts:64-68` — both supply `precedingCount`, `nextHref`,
`previousHref`), so the view does not care which produced them.

**Why not extend the keyset cursor to carry a follower count.** `KeysetCursor`
is `{timestamp, id, direction}` validated with `Date.parse`
(`keyset-cursor.ts:29-34, 133`), and all five existing sort keys are timestamps.
Generalising it is not the hard part — the NULLs are:

- 51 of 259 contacts have `followers_count IS NULL`.
- The keyset predicates use row-value tuples, `(g.created_at, g.id) < ($1, $2)`
  (`crm-repo.ts:3096, 3105-3107`). **A tuple comparison cannot express NULLS
  LAST** — a NULL first element makes the whole comparison NULL and the row
  vanishes. You would decompose into `(k < $1) OR (k = $1 AND id < $2)` plus
  NULL branches, mirrored in the `precedingSelect` FILTER and in the backward
  direction: four predicate shapes, each correct in two directions.
- The cursor cannot say "I am in the NULL group", and `toIsoRequired`
  (`:1350-1356`) throws on null.
- **`COALESCE` has no honest analogue here.** `closedOpportunities` could use
  `COALESCE(closed_at, updated_at)` because both are timestamps meaning roughly
  the same thing. `COALESCE(followers_count, 0)` would sort 51 unknowns among
  genuine zeros — and `toOrganisationListRow:169-174` and `FollowersCell`
  (`organisations-view.tsx:107-111`) exist *specifically* to keep unknown
  distinct from zero. A `-1` sentinel works mechanically and bakes a magic
  number into a shareable URL.

Under offset it is one clause: `ORDER BY pc.followers_count DESC NULLS LAST,
g.id DESC`. Correct by construction, no sentinel, no cursor.

**What we give up, stated honestly.** `listOrganisations`' own doc
(`crm-repo.ts:3037-3046`) argues keyset protects against concurrent-insert
drift: OFFSET *"shifts every subsequent page by one, silently skipping whatever
crossed the boundary — on this surface, a lead never contacted."* That is a real
property and we lose it **on sorted views only**. It does not bind here: 259
rows, `PAGE_SIZE = 100` (`page.tsx:38`) so three pages, and organisations arrive
in batch imports rather than continuously. The default view keeps its cursor, so
the protection is retained exactly where the argument was made.

Note also there is **no index on `crm_organisations.created_at`** — the CRM
indexes are `crm_contacts_org_idx`, `crm_contacts_instagram_idx`
(`0019_crm_schema.sql:100-101`), `crm_contacts_erased_idx` (`0024:27`),
`crm_org_country_idx` (`0025:34`). The current keyset already seq-scans and
sorts, so offset costs nothing extra.

## Tasks

### T1 — the repo layer

- **An allow-list, because this is the first time a URL value reaches an ORDER
  BY.** Every `sortKey` in this file today is a module literal, and
  `QueuePageQuery`'s doc says so twice (`crm-repo.ts:342-343, 346-347`): *"A
  module constant like `sortKey`, never caller input — it is spliced into the
  statement, not bound."* Add `ORGANISATION_SORTS` as a closed record and look
  it up with `Object.hasOwn`, so the **key** is validated and the **value** is
  spliced; the URL string never touches SQL. Use `Object.hasOwn`, not `in` —
  `page.tsx:142-149` records why: `?country=__proto__` passed as a valid code.
- **Collapse the four primary-contact subqueries into one `LEFT JOIN LATERAL`.**
  `contact_name`, `contact_email`, `contact_handle` and `followers_count`
  (`:3122-3144`) each repeat the same `notErased` + `primaryContactOrder`
  scan. Sorting needs the expression a fifth time; a lateral gives one scan and
  one place the primary contact is resolved. `crm_contacts_org_idx` already
  backs it. **This must preserve the invariant #563 mutation-proved** — the
  displayed count and the filtered count resolve the same contact
  (`integration.test.ts:2248, 2296-2305`).
- Parameterise the `ORDER BY` at `:3151`, with `NULLS LAST` and `g.id` as the
  final tiebreaker.
- Add `sort` and an offset alongside `cursor`. **Change the signature to an
  options object** — eleven `toHaveBeenCalledWith(filters, limit, cursor)`
  assertions in `page.test.tsx` (`:90, 128, 184, 266, 278, 295, 358, 366, 377,
  387, 391`) break on a fourth positional argument.

Done when: sorting by followers puts the 6 contacts over 10k first and the 51
unknowns last; the default view's cursor behaviour is untouched.

### T2 — the page

- `readOrganisationSort(searchParams)` beside `readOrganisationFilters`
  (`organisations/page.tsx:117`), rejecting an unknown key by reading as
  *unsorted* rather than erroring — the same contract `readQueueFilters` was
  fixed to honour in #563.
- Branch between `buildNextHref`/`buildPreviousHref` (`:210-221`) and
  `pagerLinks` on whether a sort is active.
- `?sort=`/`?dir=` survive a filter change for free: `mergeFiltersIntoQuery`
  (`filter-bar.tsx:76-92`) copies params it does not own, and
  `filter-bar.merge.test.ts:19-30` already asserts exactly `sort=created_at&dir=desc`
  is preserved. Do not add them to `CURSOR_PARAMS` — that constant exists to
  DROP a stale position, and a sort is not a position.

### T3 — the header controls

- Sortable `<TableHead>` buttons in `organisations-view.tsx:258-264`, importing
  `SortSpec` and `nextSort` from `console-data-table.tsx` (already exported)
  rather than restating the toggle logic. Set `aria-sort` as
  `console-data-table.tsx:265-276` does.
- Sortable: Name and Followers. Added (`created_at`) too, since it is the
  current fixed order and making it explicit costs nothing.
- **Do not adopt `ConsoleDataTable` itself.** Its pager is numeric-callback
  (`onPageChange(page)`, `:340-345`); this surface uses `ResultPager`, whose
  controls are `<a href>`s on purpose — *"a page of results is a location, so it
  must be back-button-navigable and shareable"* (`result-pager.tsx:44-46`).
  Swapping it in regresses paging from links to buttons and drops the FilterBar
  slot.

## Verification

Per task, from the WORKTREE root (`pnpm --filter console` run from the primary
checkout tests the primary checkout and reports green against code without the
change):

    pnpm --filter console lint
    pnpm --filter console typecheck
    pnpm --filter console test:unit

Whole branch: the above plus `pnpm --filter console build`.

## Sequencing

T1 → T2 → T3. Each consumes the previous one's interface. No migration.
