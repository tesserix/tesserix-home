---
slug: ai-metrics-pagination
created: 2026-08-29
status: in-progress
---

# `/kora/ai-metrics` fails on every load — pagination is read from the wrong place

Reported from the live surface: "Something Went Wrong", pagination is missing.

## Root cause — a contract mismatch, three defects deep

**platform-api emits pagination in `meta`, not inside `data`.** `WriteMeta`
(`platform-api/internal/platform/httpx/response.go:119`) writes
`{success, data, meta, timestamp}`.

**The console's `platformRequest` returns only `.data`**
(`apps/console/lib/platform-api.ts:270`), discarding `meta` before any parser
sees it. So `body.pagination` is not merely absent — it is structurally
unreachable. The codebase already has the right helper immediately below it,
whose doc comment names this exact trap:

> `platformRequestWithMeta` — "As `platformRequest`, but keeps `meta` —
> pagination lives there."

`fetchKoraAiMetricsPage` (`platform-api.ts:908`) calls the wrong one.

**`metaFrom` deliberately does not carry `page`**
(`platform-api/internal/modules/koraaimetrics/internal/handler/handler.go:97-103`),
and its reasoning is sound: `httpx.Meta` is cursor-oriented and has no page
field, and `page` is the one value the caller already supplied — echoing it back
carries no information the client lacks, whereas `total` and `limit` do, because
Kora clamps `limit` to its own MaxLimit so the applied value can differ from the
requested one.

So even reading `meta` correctly, `page` would still be absent — and
`parseKoraAiMetricsPagination` requires it.

## Why every gate missed it

`apps/console/lib/kora-ai-metrics.test.ts:40` fixtures
`{ page: 1, limit: 50, total: 2 }` nested under a `pagination` key — a shape
platform-api has never produced. The parser and its tests agreed with each other
and both disagreed with the producer.

Line 179 is worse: a passing test named **"refuses a response with no
pagination"**, asserting the throw. The suite encoded production's failure as
correct behaviour.

`platformRequest` returns `unknown`, so types could not catch it. Lint and
`next build` cannot see across an HTTP boundary. Only a real response could.

## Blast radius

- `/kora/ai-metrics` — **broken on every load**
- `/kora` Overview — **unaffected**. `parseKoraAiMetrics` never reads pagination
  (verified: zero matches within its body)

## The fix — console-side, NOT Go-side

Do **not** add `page` to `httpx.Meta`. That would invent a channel the service
does not otherwise have, purely to satisfy a consumer's mistaken assumption, and
it contradicts a documented decision whose reasoning is better than the
assumption's.

1. `fetchKoraAiMetricsPage` uses `platformRequestWithMeta`.
2. `parseKoraAiMetricsPagination` reads `total` and `limit` from **meta**, and
   takes `page` as an argument from the caller — which already knows it, having
   asked for it.
3. Keep refusing a genuinely malformed `meta`. An absent `total`/`limit` is still
   a broken response and must not be papered over with zeros: the surface would
   then render a confident, wrong pager, which is the same class of lie as the
   `first_try_rate_pct` case this surface already guards.

## Required tests

- a response shaped as platform-api **actually** emits it (`meta`, no `page`)
  parses correctly — the test whose absence caused this bug
- the requested page is reflected in the parsed pagination
- a malformed or absent `meta` still throws
- **delete or rewrite** `"refuses a response with no pagination"` — it asserts
  the bug. Replace with one that refuses a malformed `meta`.
- a test that would fail if `platformRequest` were used instead of
  `platformRequestWithMeta`, so the wrong helper cannot come back

## Verification

`vitest run`, `packages/*` `test:unit`, `packages/*` `typecheck`,
`tsc --noEmit`, `lint` (`--max-warnings 0`), `next build` — all six.
