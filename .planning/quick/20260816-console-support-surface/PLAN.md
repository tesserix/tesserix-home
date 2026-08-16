---
id: 260816-support
slug: console-support-surface
date: 2026-08-16
issue: 133
status: in-progress
---

# One support surface in the console

Issue #133, rescoped against the code. Escalation is #194, live chat is #197, and
the two HomeChef routes are Fe3dr-rail and out of scope — the reasoning is in
#133's comment thread and is not re-argued here.

What remains: **the merged queue, its filters, ticket-detail parity, and support
analytics as a tab** — plus a defect in the surface that already shipped.

## Standing constraints

- The console reads tickets through `apps/web`'s HTTP API, not the DB:
  `apps/console/lib/platform-api.ts:83` (`WEB_INTERNAL_ORIGIN`). Writes send
  `origin: CONSOLE_ORIGIN` to satisfy web's CSRF gate. Keep that path; do not
  reach for the `tesserix-postgres` pool, even though `lib/db/search-repo.ts`
  does for the palette.
- `PlatformApiError.status === 501` means *parked*, and maps to the
  `instrumentation-unavailable` state. `states.tsx:54` exports `NOT_IMPLEMENTED`
  so no surface hard-codes it.
- `@tesserix/web`'s barrel is itself `"use client"`; its exports resolve to
  `undefined` inside a server component. That is why every kit wrapper carries a
  load-bearing `"use client"`. New surfaces touch `@tesserix/web` only through
  `components/kit/`.
- `lib/tickets.ts` throws on a malformed payload rather than coercing. Preserve
  that: a queue that renders a blank row for a real ticket looks handled.

## Deferred judgment call, stated

The console surface keeps the path `/platform/tickets` and the route id
`platform.tickets`. "Tickets" becomes the wrong name once #197 lands the chat
inbox alongside it, but renaming now costs `routes.ts`, `nav.ts`,
`routes.console.test.ts`, `nav.test.ts` and the hard-coded href at
`lib/search.ts:148`, to fix a name that is still accurate today. Rename when
#197 makes it false.

---

## Task 1 — Kit: fix the state defect, give `QueueList` a status slot

**The defect.** `app/(console)/platform/tickets/page.tsx:55` calls
`triageState(error, null)`, which returns only
`instrumentation-unavailable | error | ready` (`lib/triage.ts:182-195`). With
zero rows the state is `ready`, so the queue renders an empty `<ul>` and the
`emptyMessage` at `:90` is unreachable; `loading` and `filtered-empty` never
occur. `resolveState` (`states.tsx:61-75`) is the right helper.

- Switch the queue to `resolveState({ isLoading, error, rows, filtered })`.
  `filtered` is true when any filter is active — that is what distinguishes
  `empty` ("nothing waiting") from `filtered-empty` ("nothing matches"), and the
  two want different copy and a Clear-filters action.
- Keep `triageState` where it is legitimately used elsewhere; do not delete it.
- Add a **status slot** to `QueueItem` (`components/kit/queue-list.tsx:10-27`):
  an optional `status?: { label: string; tone?: … }` rendered as a badge beside
  the product badge. Do **not** overload `subtitle` or `actions` for this.
  `severity` stays what it is — derived from priority — and keeps rendering as
  now.
- The status slot is optional so every existing caller compiles unchanged.

**Tests.** Cover: zero rows with no filters → `empty` and the message is
actually reached; zero rows with a filter → `filtered-empty` with the clear
action; a 501 → `instrumentation-unavailable` and *not* `error`; a row with a
status renders both badges; a row without one renders exactly as before.

---

## Task 2 — Ticket detail parity

`app/(console)/platform/tickets/[id]/`. Four capabilities exist in
`apps/web/app/admin/platform-tickets/[id]/page.tsx` and have no console
equivalent:

1. **Combined reply-and-transition.** web's composer has a "status on send"
   select (`:326-342`) and POSTs `{content, newStatus}` in one request.
   `postTicketReply` already accepts `newStatus` (`lib/platform-api.ts:229`);
   `actions.ts:50` simply never passes it. Wire it through so a reply and a
   resolve are one action, not two round trips that can half-fail.
2. **Reopen affordance** for terminal tickets (`:287-307`). The console's
   `StatusControl` is an unconditional `<select>`; a resolved ticket should
   offer reopen explicitly rather than a dropdown that happens to contain it.
3. **Tenant deep link** — web's "View tenant →" (`:193-198`). In the console it
   must go through `console-core`'s route table, never a hand-built
   `/admin/...` href, and must respect `isPending()`: if the target rail is not
   built, show it inert rather than linking into `apps/web`.
4. **Last activity** — `updatedAt` is parsed (`lib/tickets.ts:96`) and never
   rendered. Put it in the summary rail.

Keep writes as server actions re-asserting the `respond` capability
(`actions.ts:27`) and the 10,000-char ceiling.

**Tests.** Combined reply+status sends one request carrying both. A reply
without a status change still sends none. Reopen appears only on terminal
statuses. A pending tenant rail renders inert, not as a link.

---

## Task 3 — Queue: filters, product and status columns, analytics tab

Single task because all of it edits `platform/tickets/page.tsx`.

**Filters.** `GET /api/admin/platform-tickets` already accepts `?status`,
`?priority` and `?product` (`apps/web/app/api/admin/platform-tickets/route.ts:14-16`)
and no caller has ever sent them. Filtering is server-side already — use it.

- Three `type: "select"` descriptors on the kit's `FilterBar`.
- `FilterBar`/`useUrlFilters` are client-side (`useSearchParams`). The queue is
  server-rendered. Read `searchParams` on the server, pass values down, and let
  the client bar drive the URL — do not convert the page to a client component
  to get a filter bar.
- Radix cannot hold `""`; `__any__` is the existing stand-in (`filter-bar.tsx:157`).
- Product options come from the estate, not from whatever happens to be in the
  current page of rows.
- An active filter with no matches is `filtered-empty`, per Task 1.

**Columns.** Product badge already renders. Add status via Task 1's slot.

**Analytics tab.** `/admin/analytics/support` is 8 KPIs plus three bar charts.

- The 8 KPIs map onto the kit's `StatTile`, which handles all five states itself.
- **The charts do not port.** The console has no chart library and
  `@tesserix/web@1.8.1` exports none. Render the three breakdowns (by status, by
  reason, by tenant) as ranked rows with proportion bars built from existing
  primitives. Do not add recharts to the console as a side effect of moving a
  support page — that is its own decision.
- Read through `lib/platform-api.ts` against apps/web's
  `/api/admin/analytics/support`, the same way tickets are read. That endpoint
  enriches tenant ids with names from the **mark8ly** database, which the console
  cannot reach directly — going through the endpoint is what preserves the names.
- The kit has no standalone tabs primitive; `DetailLayout` is the only tabbed
  component and it forces a summary rail. Either extract a small tabs wrapper
  into `components/kit/` or import `Tabs` from `@tesserix/web` inside a client
  wrapper. Prefer the kit wrapper — a second surface will want it.
- web polls this endpoint every 30s. The console is server-rendered; a
  navigation-time read is acceptable for v1. Do not introduce SWR here.

**Tests.** Filters reach the API as query params. A filtered no-match renders
`filtered-empty` with a clear action. Analytics 501 renders
`instrumentation-unavailable` on the tab without taking the queue down with it.

---

## Task 4 — Retire the old routes

Only after 1–3 are green.

- `redirects()` in `apps/web/next.config.ts` (the block already exists at
  `:20-32`) for `/admin/platform-tickets`, `/admin/platform-tickets/:id` and
  `/admin/analytics/support` → the console. **Not** `/admin/support/live-chat` —
  #197 owns that one and it must keep working.
- Delete those three `page.tsx` files. `BASELINE.adminPages` 72 → 69 in
  `apps/web/lib/admin-surface.ratchet.test.ts`, **in the same commit** — the
  drift guard allows a gap of 5 and lowering the baseline needs no
  justification, only raising it does.
- **Do not delete anything under `app/api/admin/`.** The console calls
  `/api/admin/platform-tickets*` and `/api/admin/analytics/support`
  server-to-server; mobile calls others. `BASELINE.adminApiRoutes` is unchanged.
- `packages/console-core`: drop the `platform.supportAnalytics` nav entry
  (`nav.ts:54`) and mark its route entry retired. `routes.console.test.ts:78-92`
  asserts on which surfaces are pending — update it deliberately, and keep
  `platform.liveChat` pending until #197.

---

## Verification

- `pnpm test` at the root, `pnpm build` for the console.
- `redirect-origin.guard.test.ts` and `admin-surface.ratchet.test.ts` both green.
- The five states are reachable on the queue — asserted, not eyeballed.
