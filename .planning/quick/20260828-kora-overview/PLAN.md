---
slug: kora-overview
created: 2026-08-28
status: in-progress
---

# `/kora` Overview — an operational snapshot

`kora.overview` is declared in `packages/console-core/src/routes.ts:116` with
`pending: true`, sits in the sidebar via `koraNav` (`nav.ts:43`), and is counted
in `estate.ts`'s `entries: 3` for Kora — but **no page exists**. It is a promise
in the rail that links nowhere. This builds it.

## What it answers

"Is kora OK, and what needs me?" — assembled entirely from routes that already
exist. No new platform-api work.

| Tile | Source | Links to |
|---|---|---|
| Foods | `fetchProductEntities` for `foods`, `limit=1`, read `pagination.total` | `/kora/foods` |
| Users | `fetchProductEntities` for `users`, `limit=1`, read `pagination.total` | `/kora/users` |
| Needs attention | `fetchEstateInbox("kora")` — kora's unresolved-food queue and feedback | the estate Inbox, kora-filtered |
| AI resolution | **new** `fetchKoraAiMetrics()` → `GET /v1/kora/ai-metrics` | nothing yet — that surface is a separate piece |

## Non-negotiables

1. **`first_try_rate_pct` is a pointer upstream.** Kora returns it *absent*, not
   `0.0`, when the window measured nothing (`ai_metrics.go:37-45`, deliberate).
   The tile must render "not measured" — never "0%". A dashboard showing a
   confident zero for an unmeasured window is worse than showing nothing, and
   this is the single most likely way this page ships a lie.

2. **Counts come from `pagination.total` with `limit=1`.** Do not fetch 50 rows
   and count them.

3. **Four independent reads, narrowed separately.** Follow the established
   `Promise.allSettled` + per-surface `SurfaceState` pattern used by
   `app/(console)/platform/billing/catalog/page.tsx`. A failed tile renders its
   own error state; it must not take down the other three, and a genuine failure
   must not be dressed up as "migrations pending" / "not implemented".

4. **Federation is live but each read can still fail.** `FEDERATION_PRODUCTS`
   includes `kora` in prod, so these routes answer — but treat every read as
   fallible. `/v1/kora/ai-metrics` returns 501 when kora is undeclared, which is
   a legitimate state to render, not an error.

5. **Flip `pending` to false on `kora.overview`** so the rail entry becomes a
   real link. `koraNav` still has 3 entries, so `estate.ts`'s `entries: 3`
   assertion is unaffected — verify that, do not change the count.

## Files

- create `apps/console/app/(console)/kora/page.tsx` (server component)
- create `apps/console/app/(console)/kora/overview-view.tsx` (client)
- create `page.test.tsx` and `overview-view.render.test.tsx`
- modify `packages/console-core/src/routes.ts` — `pending` on `kora.overview`
- modify `apps/console/lib/platform-api.ts` — add `fetchKoraAiMetrics`
- create a small parser for the metrics shape, following `lib/inbox.ts` /
  `lib/entities.ts` convention

## The upstream shape (`GET /v1/kora/ai-metrics`)

Envelope `{data, pagination}`. `data.window = {from, to}`;
`data.outcomes = {attempts, by_kind{…}, needs_human, first_try_rate_pct?}`;
`data.users[]`. platform-api passes kora's `data` through **undecoded** as
`json.RawMessage` and decodes only pagination, so the console is the first place
this shape is modelled — model only the fields the tile renders.

## Required tests

- each tile: ready, empty, and failed
- **`first_try_rate_pct` absent renders "not measured", not 0%** — and a test
  that would fail if it rendered `0`
- one failed read still renders the other three tiles
- a page-level test for the read wiring
- the rail entry is no longer `pending`

## Verification

- `pnpm --filter console exec vitest run` — full suite, 2437 passing at baseline
- `pnpm --filter console exec tsc --noEmit` — zero errors
- `pnpm --filter console lint` — zero warnings (`eslint --max-warnings 0`)
- `pnpm --filter console build`
- `pnpm --filter './packages/*' typecheck` — because `routes.ts` is touched

## Out of scope

Kora's own health probes (`/v1/admin/health` is not federated — it would need a
new platform-api route), the `ai-metrics` full surface, and kora's unswept
`platform_request_nonces` table.
