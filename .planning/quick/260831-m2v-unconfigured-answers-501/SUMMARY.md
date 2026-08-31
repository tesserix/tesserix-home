---
quick_id: 260831-m2v
slug: unconfigured-answers-501
date: 2026-08-31
issue: tesserix-home#198
status: complete
branch: fix/198-unconfigured-answers-501
---

# An unconfigured upstream answers 501, not 503 — done

The two `/api/admin/*` proxies that predated the contract now answer **501** for
an unset `OTTO_INTERNAL_AUTH`, so a parked otto integration renders as the
console's calm `instrumentation-unavailable` callout rather than a red error.
The contract itself is now written down in the conventions doc instead of
living only in one route's header.

## Files changed

| File | Change |
| --- | --- |
| `apps/web/app/api/admin/analytics/support/route.ts` | unset-credential branch `503` -> `501`, plus a docstring saying why |
| `apps/web/app/api/admin/otto/[...path]/route.ts` | unset-credential branch `503` -> `501`, plus a docstring saying why |
| `docs/PLATFORM-API-CONVENTIONS.md` | new **§1c** — the rule, stated for every `/api/admin/*` proxy |
| `apps/web/app/api/admin/analytics/support/route.test.ts` | new — 4 tests |
| `apps/web/app/api/admin/otto/[...path]/route.test.ts` | new — 5 tests |

`apps/web/app/api/admin/apps/[product]/audit-logs/route.ts` was **not** touched.
No 502 was touched. No 401 was touched. No console change.

## Where the contract is recorded

`docs/PLATFORM-API-CONVENTIONS.md` **§1c — "An unconfigured upstream answers
501, never 503"**, inserted between §1b and §2. It states the rule for *every*
`/api/admin/*` proxy the console reads, not as a note about these two routes:

- **501** `{ error: "not_configured", … }` — never wired, nothing was attempted.
- **502** `{ error: "upstream_unavailable" | "upstream_error", … }` — wired and
  failing: reached and 5xx'd, timed out, or the transport threw.

It carries an explicit scope note, because the rest of §1 governs what a Go
module puts on the wire and this rule governs the console's own Next.js proxy
layer. It names `apps/console/components/kit/surface-state.ts` (`NOT_IMPLEMENTED
= 501`) as the reader, `audit-logs/route.ts` as the worked example, and closes
with the testing rule: assert the literal, never import the console constant.

Each route also carries its own long comment at the changed branch naming the
failure mode and citing #198, §1c and `audit-logs/route.ts` — matching the
register set by the `audit-logs` header.

## Verification — actual output

### RED check (the tests do bite)

Before trusting a green run, both routes were temporarily reverted to `503` and
the new files re-run:

```
RED_EXIT=1
 Test Files  2 failed (2)
      Tests  2 failed | 7 passed (9)
```

Exactly the two status assertions failed; the routes were then restored to
`501`.

### `pnpm test`

```
TEST_EXIT=0

@tesserix/homechef-shared:test:unit:  Test Files  1 passed (1)
@tesserix/homechef-shared:test:unit:       Tests  9 passed (9)
@tesserix/platform-auth:test:unit:  Test Files  7 passed (7)
@tesserix/platform-auth:test:unit:       Tests  120 passed (120)
@tesserix/console-core:test:unit:  Test Files  6 passed (6)
@tesserix/console-core:test:unit:       Tests  87 passed (87)
console:test:unit:  Test Files  177 passed (177)
console:test:unit:       Tests  2957 passed (2957)
web:test:unit:  Test Files  25 passed (25)
web:test:unit:       Tests  270 passed (270)

 Tasks:    8 successful, 8 total
Cached:    7 cached, 8 total
```

`web:test:unit` was a **cache miss, executed** (`cache miss, executing
2a6c03b1ba900048`) — the 270 above are a real run, not a replay. The other
seven tasks were cache hits on packages this change does not touch. The two new
files inside that run:

```
web:test:unit:  ✓ app/api/admin/analytics/support/route.test.ts (4 tests) 42ms
web:test:unit:  ✓ app/api/admin/otto/[...path]/route.test.ts (5 tests) 34ms
```

Vitest emits pre-existing `TSConfckParseError` noise for `.claude/worktrees/*`
tsconfigs. It predates this change, is unrelated to it, and does not fail the
run.

### `pnpm --filter web build`

```
BUILD_EXIT=0

▲ Next.js 16.2.11 (Turbopack)
- Environments: .env.local
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
  Creating an optimized production build ...
✓ Compiled successfully in 18.5s
  Running TypeScript ...
  Finished TypeScript in 15.1s ...
  Collecting page data using 13 workers ...
✓ Generating static pages using 13 workers (125/125) in 1795ms

├ ƒ /api/admin/analytics/support
├ ƒ /api/admin/apps/[product]/audit-logs
├ ƒ /api/admin/otto/[...path]
```

The `middleware`-deprecation warning is pre-existing and unrelated.

### `pnpm --filter web lint` (not required by the plan; run because CI does)

```
LINT_EXIT=0
> eslint --max-warnings 0
```

## Deviations and judgement calls

1. **Where §1c went.** `docs/PLATFORM-API-CONVENTIONS.md` is written about the
   Go platform-api modules, and this rule is about `apps/web`'s Next.js proxies.
   The plan named it as the closest existing home and there is no other file
   recording console proxy response shapes (`apps/web/README.md` does not
   exist; `docs/api/` holds one feature plan). Rather than smooth that over,
   §1c opens with an explicit scope note saying it differs from the rest of §1
   — matching the doc's own habit of writing disagreements down as
   disagreements.

2. **One extra test beyond the plan's two-per-route.** Each file also asserts
   that the unset-credential path never calls `fetch`. Without it, "501" and
   "502" are just two integers; with it, the 501 is pinned to mean *nothing was
   attempted*, which is the distinction the contract turns on. The otto file
   additionally covers upstream-returns-5xx -> 502, the second "wired and not
   answering" shape, which has a different code path from the throw.

3. **Tests re-import the route per case.** `OTTO_INTERNAL_AUTH` is read into a
   module const at import time, so a hoisted `import { GET }` would freeze one
   value for the whole file and the unset case could never be exercised. Each
   test does `vi.resetModules()` -> `vi.stubEnv` -> `await import("./route")`,
   the pattern already used in `apps/web/lib/api/kora-admin.test.ts`.

4. **Statuses asserted as literals**, per the plan — plus a negative assertion
   (`not.toBe(503)` / `not.toBe(501)`) so the specific regression is named.
   Nothing imports the console's `NOT_IMPLEMENTED`.
