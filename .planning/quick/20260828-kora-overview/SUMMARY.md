---
slug: kora-overview
status: complete
completed: 2026-08-28
---

# `/kora` Overview — summary

## What was built

- `apps/console/app/(console)/kora/page.tsx` — server component. Four
  independent reads via `Promise.allSettled`: `fetchProductEntities("kora",
  "foods", undefined, 1, 1)`, the same for `"users"`, `fetchEstateInbox("kora")`,
  and the new `fetchKoraAiMetrics()`. Each read's rejection is narrowed
  independently through the exported `tileState()` helper, so a failed read
  renders only its own tile's non-ready state and never blanks the other three.
- `apps/console/app/(console)/kora/overview-view.tsx` — client component
  (`KoraOverview`). Renders four `StatTile`s (Foods -> `/kora/foods`,
  Users -> `/kora/users`, Needs attention -> `/platform/inbox`, and an "AI
  resolution" section with three sub-tiles: attempts, needs-human, first-try
  rate). A single shared reauth banner replaces four duplicate ones when more
  than one read needs it (mirrors `AnalyticsPanel`'s existing pattern).
  Exports the pure `formatFirstTryRate(pct)` function — the one place
  `first_try_rate_pct` becomes copy.
- `apps/console/lib/kora-ai-metrics.ts` — new parser, `parseKoraAiMetrics`.
  Models only `outcomes.attempts`, `outcomes.needs_human`,
  `outcomes.first_try_rate_pct` (optional) — nothing else Kora's `data` object
  carries (`window`, `by_kind`, `users`), following the §8.9 discipline
  `entities.ts`/`inbox.ts` already use.
- `apps/console/lib/platform-api.ts` — added `fetchKoraAiMetrics()` (calls
  `GET /v1/kora/ai-metrics`, no window/paging params). Extended
  `fetchProductEntities` with an optional fifth `limit` parameter (defaults to
  the existing `ENTITIES_LIMIT`), so the overview's count-only reads can pass
  `limit=1` instead of fetching 50 rows to discard them. Both existing call
  sites (`kora/foods/page.tsx`, `kora/users/page.tsx`) are unaffected — they
  omit the new parameter and keep their previous behaviour exactly.
- `packages/console-core/src/routes.ts` — dropped `pending: true` from
  `kora.overview`. Rebuilt via `pnpm --filter console-core run build` so the
  console picks up the change (its `dist/` is gitignored).
- Updated two pre-existing tests that asserted the OLD "Overview is pending"
  behaviour, now that it's real: `components/nav/sidebar.render.test.tsx`
  ("links Kora's built pages and keeps Overview pending" ->
  "links every one of Kora's built pages") and `lib/search.test.ts` (moved
  `kora.overview` from the "still pending and advertised" example to the
  "built pages" list, replacing it with `platform.liveChat` as the sole
  remaining durable pending-and-advertised example).

`koraNav` is still 3 entries; `estate.ts`'s `entries: 3` assertion for Kora is
unaffected (verified — that test passed unchanged).

## Test evidence

Scoped:
```
pnpm --filter console exec vitest run "app/(console)/kora"
-> 7 test files, 70 tests passed
```

Full suite:
```
pnpm --filter console exec vitest run
-> 153 test files, 2468 tests passed (baseline 2437 + 31 new: 8 in
  kora-ai-metrics.test.ts, 12 in overview-view.render.test.tsx, 11 in
  page.test.tsx)
```

Typecheck:
```
pnpm --filter console exec tsc --noEmit   -> zero errors
pnpm --filter './packages/*' typecheck    -> zero errors (console-core included)
```

Lint:
```
pnpm --filter console lint (eslint --max-warnings 0)  -> zero warnings
```

Build:
```
pnpm --filter console build -> succeeded, "Running TypeScript ... Finished"
included; route table lists f /kora, f /kora/foods, f /kora/users. No `pg` /
server-only bundling failure — confirms `overview-view.tsx`'s `import type`
discipline across the client boundary held.
```

## Mutation check — the "not measured" non-negotiable

Per the task's instruction, `formatFirstTryRate` in `overview-view.tsx` was
temporarily changed from:
```ts
if (pct === undefined) return "Not measured";
return `${Math.round(pct)}%`;
```
to:
```ts
return `${Math.round(pct ?? 0)}%`;  // renders 0% for the absent case
```
Re-ran `pnpm --filter console exec vitest run "app/(console)/kora/overview-view.render.test.tsx"`:
2 tests failed as expected —
`formatFirstTryRate > reads an absent rate as not measured, never as a zero`
and
`KoraOverview — the four independent tiles > renders 'Not measured' for the AI
tile when first_try_rate_pct is absent from an otherwise successful read`.
The implementation was then reverted to the original, and the full scoped
suite (12/12) passed again. This proves the test suite would have caught the
exact "confident zero" mistake the task called out as the most likely way
this page ships a lie.

## Notes / concerns

- The "Needs attention" tile links to `/platform/inbox` unfiltered rather
  than a Kora-scoped URL — `platform/inbox/page.tsx` and `InboxQueue` have no
  `?source=` filtering support today, so a `?source=kora` link would silently
  do nothing. The DATA read (`fetchEstateInbox("kora")`) is correctly scoped;
  only the link target is not, which is honest given what the destination
  page actually does. Filtering support on `/platform/inbox` itself is out of
  this task's scope.
- `tileState()` treats the AI metrics read as never "empty" on success
  (`rows: aiMetrics ? [aiMetrics] : []`) — a window with zero attempts is
  still a real, ready answer, distinct from `first_try_rate_pct` being
  absent, which is the one sub-field that can be genuinely unmeasured.
