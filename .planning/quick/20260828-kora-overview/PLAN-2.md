---
slug: kora-overview
part: 2
created: 2026-08-28
status: in-progress
---

# Close the two remaining console-side kora gaps

Extends the same branch/PR (#420). Part 1 built `/kora` Overview; this closes the
two gaps that PR documented as deliberately unfixed.

## A. `/platform/inbox` honours a `source` filter

**The problem.** `fetchEstateInbox(source?)` has taken a source filter all along
(`lib/platform-api.ts:838`) — the *page* never passes one. `page.tsx:162` calls
`fetchEstateInbox()` bare. So the Overview's "Needs attention" tile counts kora
correctly and then links to an unfiltered estate queue.

**The fix.** `/platform/inbox` reads `?source=` from `searchParams` and passes it
through. Then the Overview tile links to `/platform/inbox?source=kora`.

Constraints:

- **No param must behave exactly as today** — the whole estate, unfiltered. This
  is a shared surface other products rely on; a default that quietly narrows it
  is a regression for every one of them.
- `fetchEstateInbox` already treats `"all"` as the *absence* of a filter, and the
  API refuses an unknown source with a 400 rather than returning nothing (there
  is a comment saying exactly this) — so an unknown/garbage `source` must surface
  as a legible error, not an empty queue. Decide deliberately: reject it in the
  page, or let the 400 render through the existing surface-state path. Say which
  and why.
- If the page has a visible filter control, it must reflect the active source
  rather than silently disagreeing with the URL. If it has none, do NOT build one
  — that is a separate design question, and the URL param is enough for a link
  target.

## B. A full `/kora/ai-metrics` surface

**The problem.** `GET /v1/kora/ai-metrics` was federated by #412 and, before this
branch, rendered nowhere. Part 1's Overview shows three headline numbers. The
endpoint returns considerably more: a per-kind outcome breakdown and a paginated
per-user table.

**The fix.** A real surface at `/kora/ai-metrics`.

Shape upstream (already modelled in part 1's `lib/kora-ai-metrics.ts` — extend it,
do not write a second parser):

```
data.window   = {from, to}                       // RFC3339 UTC, always concrete
data.outcomes = {attempts, by_kind{…10 kinds, zero-filled},
                 needs_human, first_try_rate_pct?}
data.users[]  = {user_id, attempts, resolves, corrections,
                 budget_refusals, ai_calls, last_activity_at?}
pagination    = {page, limit, total}             // 1-based, default 50, max 200
```

Requirements:

- **`first_try_rate_pct` stays absent-vs-zero correct.** Part 1 got this right at
  three layers; reuse that helper rather than re-deriving it. A measured `0`
  renders `0%`; an unmeasured window renders "not measured".
- **`last_activity_at` is optional too** — render its absence honestly, do not
  substitute an epoch or "never" if the field is simply missing.
- **`by_kind` is zero-filled upstream across 10 kinds.** Render all of them,
  including zeros — a kind silently dropped because it is 0 hides that kora
  measured it and found none, which is different from not measuring it.
- **Pagination** follows the existing `entity-page.ts` helpers (`readPage`,
  `pageHref`, `pagerLinks`) that `/kora/foods` and `/kora/users` share. Do not
  invent a second pager.
- **The window is a real datum, not chrome** — show `from`/`to` so a reader knows
  what period the numbers cover. The endpoint accepts `from`/`to`; whether the
  surface exposes a picker is your call, but state the window either way.
- 501 (kora not declared to platform-api) renders as `instrumentation-unavailable`,
  exactly as part 1 does. Not an error.

**Wiring:**

- new route id `kora.aiMetrics` in `packages/console-core/src/routes.ts`,
  `capability: "platform"`, not pending
- a `koraNav` entry (`nav.ts:43`) — this takes Kora's rail from 3 entries to 4
- **`estate.ts`'s Kora `entries: 3` must become `entries: 4`.** `estate.test.ts`
  derives its assertion from `koraNav.length`, so it will catch a mismatch — but
  the literal still needs updating
- the Overview's AI tiles should link here now that a destination exists

## Verification — ALL of these, every time

The two CI failures on this branch were both verification gaps on my side, not
implementation faults. Do not repeat them:

- `pnpm --filter console exec vitest run`
- **`pnpm --filter './packages/*' test:unit`** ← missed once; a `routes.console.test.ts`
  assertion failed in CI because only *typecheck* was run for packages
- `pnpm --filter './packages/*' typecheck`
- `pnpm --filter console exec tsc --noEmit`
- **`pnpm --filter console lint`** ← `--max-warnings 0`; missed once on an earlier branch
- `pnpm --filter console build`
- rebuild `console-core` after touching `routes.ts`/`nav.ts`/`estate.ts`

## Out of scope

Kora's own health probes — `/v1/admin/health` is not federated and would need a
new platform-api route, which is a design question rather than a wiring one.
Kora's unswept `platform_request_nonces` table (different repo).
