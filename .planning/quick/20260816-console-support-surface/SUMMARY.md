---
id: 260816-support
slug: console-support-surface
date: 2026-08-16
issue: 133
status: complete
---

# One support surface in the console

The merged ticket queue, its filters, ticket-detail parity and support analytics
as a tab now live in `apps/console`. `apps/web`'s three support pages are gone
and redirect there. Escalation (#194), live chat (#197) and the two HomeChef
Fe3dr-rail routes were out of scope from the start — the reasoning is in #133's
comment thread.

## Commits

| Commit    | What                                                                    |
| --------- | ----------------------------------------------------------------------- |
| `3b7a5d2` | Task 1 — queue state resolved from its rows; `QueueItem.status` slot     |
| `ff860ac` | Task 2 — ticket detail parity                                           |
| `66e3068` | Task 2 fixup — detail state resolved from the record, so "missing" shows |
| `4100dd2` | Task 3 — `SurfaceTabs` and ranked-bar breakdowns in the kit             |
| `d0f12e7` | Task 3 — queue filters and the analytics tab                           |
| `631521f` | Task 3 — corrected the comment on why ranked rows, not a bar chart     |
| `832c7f3` | Task 4 — retired the admin pages the console replaces                  |

## What shipped

**Task 1 — the state defect.** The queue called `triageState(error, null)`,
which can only return `instrumentation-unavailable | error | ready`: zero rows
reported `ready` and rendered an empty `<ul>`, so `emptyMessage` was unreachable
and `filtered-empty` could not occur at all. It now resolves through
`resolveState({ isLoading, error, rows, filtered })`. `triageState` stays where
it is legitimately used. `QueueItem` gained an optional `status` slot rendered
as a badge beside the product badge — `severity` still means priority, and the
two are now distinguishable on a row.

**Task 2 — ticket detail parity.** Four capabilities that only existed in
`apps/web`: combined reply-and-transition (one request carrying `content` and
`newStatus`, not two round trips that can half-fail), an explicit reopen
affordance on terminal statuses, the tenant deep link resolved through
console-core's route table, and `updatedAt` rendered in the summary rail. Writes
remain server actions that re-assert `respond` and the 10,000-char ceiling.

**Task 3 — filters, columns, analytics tab.** Three server-side filters
(`?status`, `?priority`, `?product`) that the endpoint had accepted since it
shipped and no caller had ever sent. The page stays server-rendered: it reads
`searchParams` and passes values down, and the client `FilterBar` drives the
URL. Product options come from the estate, not from the rows on screen. The
eight support KPIs render as `StatTile`s and the three breakdowns as ranked rows
with proportion bars, under a new `SurfaceTabs` kit primitive. Queue and
analytics resolve their states independently — `Promise.allSettled`, not
`Promise.all` — so a parked analytics endpoint does not take the queue down.

**Task 4 — retirement.** `/admin/platform-tickets`,
`/admin/platform-tickets/:id` and `/admin/analytics/support` are permanent
redirects to the console; the three `page.tsx` files are deleted and
`BASELINE.adminPages` is 72 → 69 in the same commit. Nothing under
`app/api/admin/` was touched: the console reads
`/api/admin/platform-tickets*` and `/api/admin/analytics/support`
server-to-server and mobile calls the rest, so `adminApiRoutes` (51) and
`internalApiRoutes` (6) are unchanged. In console-core,
`platform.supportAnalytics` left the nav and its route entry is marked
`retired`.

## Deliberately left

- **Escalation — #194.** Chat → ticket as a single action. Depends on a chat
  surface that does not exist here yet.
- **Live chat — #197.** `/admin/support/live-chat` is untouched: not redirected,
  not deleted, still `pending` in console-core. Redirecting it would take a
  working surface offline with nowhere to land. `admin-surface.ratchet.test.ts`
  now asserts the page is still present so a future sweep does not take it by
  accident.
- **The two HomeChef routes.** Fe3dr-rail, out of scope per #133.
- **Charts.** The three breakdowns are ranked rows with proportion bars, not bar
  charts. The console has no chart library and `@tesserix/web@1.8.1` exports
  none; adding recharts as a side effect of moving a support page is its own
  decision, not this one.
- **The `platform.tickets` route id and path.** "Tickets" becomes the wrong name
  once #197 puts a chat inbox alongside it. Renaming now costs `routes.ts`,
  `nav.ts`, two test files and the hard-coded href at `lib/search.ts:148`, to fix
  a name that is still accurate. Rename when #197 makes it false.
- **`apps/web`'s own links to the retired pages.** `nav-config.ts:73-74`,
  `command-palette.tsx:93`, `configs.ts:107` and `users-search.ts:115` still
  point at `/admin/platform-tickets` and `/admin/analytics/support`. They now hit
  the redirect and land in the console, which is what the redirect is for. Left
  in place on purpose: muscle memory keeps working, and rewriting them is part of
  retiring the surrounding rail, not this change.

## Known divergences from apps/web

- **Polling.** web re-fetched `/api/admin/analytics/support` every 30s. The
  console reads at navigation time. Acceptable for v1; SWR was not introduced
  for it.
- **The analytics tab is not deep-linkable.** `SurfaceTabs` holds the active tab
  in local state rather than the query string — both panels are rendered by the
  server in one pass, and a `?tab=` param would collide with the filter params
  this surface already owns. Consequence: `/admin/analytics/support` redirects to
  `/platform/tickets` and lands on the Queue tab, with Analytics one click away.
  A bookmark of the old analytics page therefore arrives one click short.
- **FanZone tickets have no filter option.** `platform_tickets` carries
  `fanzone` rows and FanZone is outside the estate's first cut, so those tickets
  appear unfiltered but cannot be isolated. Product options come from the estate
  by design; this is the cost of that.
- **Tenant deep link is inert.** `platform.apps` is `pending`, so the ticket
  detail shows the tenant id as text rather than a link. Deliberate: the contract
  in `routes.ts` forbids linking a pending route in-app (no page) or back to
  `apps/web` (retiring). **`platform.apps` must stay pending until the Apps rail
  is built** — un-pending it makes that a live link to a page that does not
  exist. `tenant-link.render.test.tsx` mocks `isPending` and cannot catch a
  premature flip, so `routes.console.test.ts` now asserts it directly and says
  why.
- **Mobile still serves support analytics standalone**
  (`apps/mobile/app/platform/analytics-support.tsx`). "Retired" is per-renderer,
  which is why the route id was marked rather than deleted.

## Corrections made along the way

- `console-core`'s `platform.supportAnalytics` recorded
  `mobile: "/platform/support-analytics"`. Expo-router serves that screen at
  `/platform/analytics-support`, and `(tabs)/platform.tsx` links exactly that.
  Corrected in the same commit. Nothing consumes the id's mobile path, which is
  why a wrong entry in the table that exists to prevent this drift survived.
- `apps/web`'s `pnpm typecheck` failed after the deletions on stale
  `.next/dev/types/validator.ts`, which `next build` does not regenerate.
  Removing the gitignored `.next/dev` directory clears it. A fresh checkout never
  sees this; a machine that has run `next dev` will.

## Follow-ups already filed

- **#195** — `NEXT_PUBLIC_SITE_URL` is unset in deploy and defaults to localhost
  at build time.
- **#196** — the CSRF allowlist is derived from the request's own
  `X-Forwarded-Host`.
- **#198** — an unconfigured upstream answers 503, so the console shows an error
  where it should show "not measured". Only 501 currently maps to
  `instrumentation-unavailable`.
- **#194** and **#197** remain the two open pieces of the support surface.

## Verification

Root `pnpm test --force` (no cache), both apps' `pnpm typecheck` and
`pnpm lint --max-warnings 0`, and `pnpm build` for the console and for
`apps/web`:

```
@tesserix/platform-auth:test:unit:  Test Files  5 passed (5)
@tesserix/platform-auth:test:unit:       Tests  43 passed (43)
@tesserix/console-core:test:unit:  Test Files  6 passed (6)
@tesserix/console-core:test:unit:       Tests  40 passed (40)
@tesserix/homechef-shared:test:unit:  Test Files  1 passed (1)
@tesserix/homechef-shared:test:unit:       Tests  9 passed (9)
web:test:unit:  Test Files  20 passed (20)
web:test:unit:       Tests  206 passed (206)
console:test:unit:  Test Files  44 passed (44)
console:test:unit:       Tests  473 passed (473)
 Tasks:    8 successful, 8 total
Cached:    0 cached, 8 total
```

`admin-surface.ratchet.test.ts` (7 tests) and `redirect-origin.guard.test.ts`
(2 tests) are both green. The redirect tests resolve paths through Next's own
`getPathMatch` and `prepareDestination` rather than a reimplementation, because
the question they answer — does the query string survive — is Next's behaviour,
not this repo's. The ratchet was mutation-checked by restoring
`app/admin/platform-tickets/page.tsx`: two tests fail, the baseline and the
named-page assertion.
