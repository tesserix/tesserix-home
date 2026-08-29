---
slug: ai-metrics-pagination
status: complete
---

# `/kora/ai-metrics` pagination fix — summary

## What changed (console only, no Go touched)

- `apps/console/lib/kora-ai-metrics.ts`
  - `parseKoraAiMetricsPagination(json)` → `parseKoraAiMetricsPagination(meta, page)`.
    Reads `total`/`limit` from the caller-supplied `meta` object (the envelope's
    `meta`, never a `pagination` sibling inside `data` — that key does not
    exist on the wire) and takes `page` as an argument, since `metaFrom`
    (Go handler) never emits one.
  - Still throws on a missing/malformed `meta`, and still throws on a
    non-whole/negative `total` — no defaulting to zero.
  - Doc comments on `parseKoraAiMetricsPagination` and on `KoraAiMetrics.users`
    rewritten: they described a `pagination` sibling object that platform-api
    has never produced. They now describe `meta` and cite
    `platform-api/internal/platform/httpx/response.go` and
    `koraaimetrics/internal/handler/handler.go` for the actual contract.
- `apps/console/lib/platform-api.ts`
  - `fetchKoraAiMetricsPage` now calls `platformRequestWithMeta` instead of
    `platformRequest`, and passes `{ data, meta }` to the two parsers
    separately, with `page` forwarded to `parseKoraAiMetricsPagination`.
  - Doc comment above it rewritten to state where pagination actually lives
    (`meta`, not `data`) and why `platformRequestWithMeta` is required.

## TDD evidence

Wrote the new `parseKoraAiMetricsPagination` tests first, shaped as
platform-api actually emits (`meta = { total: 2, limit: 50 }`, no `page`,
no `pagination` key at all), and ran them against the unmodified parser.
Confirmed RED — the failure was for the right reason, not a syntax error:

```
✗ reads total and limit from meta, exactly as platform-api emits it
  PlatformApiError: kora ai metrics: pagination is missing
✗ refuses a meta missing total / limit
  PlatformApiError: kora ai metrics: pagination is missing
```

(The old code called `obj(body.pagination, "pagination")` on a `body`
constructed from a two-argument call it wasn't expecting — `pagination` was
never present, so it failed on that key rather than on `total`/`limit`,
proving the fixture-vs-producer mismatch the plan described.)

Then implemented the fix; all 21 tests in `kora-ai-metrics.test.ts` went GREEN.

## The misleading test — replaced

`"refuses a response with no pagination"` (old line 179) asserted the parser
throws when given the OLD shape's `body` with no `pagination` key — which is
exactly what platform-api's real response looks like, so this test was
asserting production's failure as correct behaviour.

Replaced with five tests that exercise the real contract:
- `"refuses a malformed meta — missing entirely"` (`undefined` in)
- `"refuses a meta missing total"`
- `"refuses a meta missing limit"`
- `"refuses a non-whole or negative total"` (kept, adapted to the new shape)
- plus two positive tests: reads `total`/`limit` from a real `meta`, and
  reflects the caller's requested `page` back correctly.

None of these assert that a *well-formed* response fails. They assert that a
genuinely broken `meta` (missing or malformed) still throws — preserving the
"absent is not zero" discipline this surface already applies to
`first_try_rate_pct`.

## Helper-choice pin

Added `describe("fetchKoraAiMetricsPage", ...)` in `platform-api.test.ts`
with two tests that mock `fetch` to return a real envelope
(`{ success, data, meta }`, `data` carrying **no** `pagination` field) and
assert on the resolved `result.pagination` — not a log line. Verified the pin
works: temporarily reverted `fetchKoraAiMetricsPage` to use `platformRequest`
(which discards `meta`) and re-ran just this describe block — both tests
failed with `PlatformApiError: kora ai metrics: meta is missing`, confirming
a regression to the wrong helper is caught. Reverted the temporary edit
before finishing.

## Overview path (`/kora`) — confirmed unaffected

`fetchKoraAiMetrics` (used by `/kora` Overview) still calls `platformRequest`
and `parseKoraAiMetrics` only — untouched by this change. `parseKoraAiMetrics`
never reads pagination. The full `kora-ai-metrics.test.ts` suite (including
all pre-existing `parseKoraAiMetrics` tests) passes unchanged, and
`app/(console)/kora/ai-metrics/page.tsx`'s only call into the changed API is
`fetchKoraAiMetricsPage(page)`, whose external signature (`page` in, `{
metrics, pagination }` out) did not change.

## Command results (all six required)

1. `pnpm --filter console exec vitest run` — 155 files, 2516 tests passed.
2. `pnpm --filter './packages/*' test:unit` — all packages passed
   (platform-auth 92, console-core 76, homechef-shared 9, crm-country n/a).
3. `pnpm --filter './packages/*' typecheck` — 6/10 workspace projects with a
   typecheck script, all `Done` with no errors.
4. `pnpm --filter console exec tsc --noEmit` — clean, no output.
5. `pnpm --filter console lint` (`--max-warnings 0`) — clean, no output.
6. `pnpm --filter console build` — `next build` succeeded, all routes
   compiled including `/kora/ai-metrics`.

## Diff scope

Four files touched, all within the stated fix: `kora-ai-metrics.ts`,
`kora-ai-metrics.test.ts`, `platform-api.ts`, `platform-api.test.ts`. No Go
files changed. `PLAN.md` and this `SUMMARY.md` committed alongside.
