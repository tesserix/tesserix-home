# T2 — #545 + #547

Branch `fix/console-followups-544-547`, worktree `th-wt-fu`. `apps/console` only,
plus a doc-comment-only change in `packages/console-core/src/route-access.ts`.

## #545 — the server-component web-import guard now walks lib/ and components/ and .ts

`apps/console/lib/server-component-web-import.guard.test.ts` walked
`<console>/app` filtered on `.endsWith(".tsx")`. It now walks `app/`, `lib/` and
`components/`, accepting `.ts` and `.tsx`, still skipping `.test.` files.

### Did widening surface an existing violation? NO.

Counted before changing the test, by a standalone scan, and again by the test
itself afterwards — the two agree:

- 235 non-test `.ts`/`.tsx` files across `app/`, `lib/`, `components/`
- 160 of them carry no `"use client"` line, so are treated as server modules
- **0** of those import `@tesserix/web`

The suite reports 164 tests in this file: 160 per-module rows + 1 roots
assertion + 3 per-root vacuity rows. (Counted from the run, then re-derived from
the scan; they match.)

### How this divides with `components/kit/use-client-boundary.test.ts`

The two state the same invariant from opposite sides and neither subsumes the
other. `use-client-boundary` is the **stricter** one on its territory: it
requires the first non-comment, non-blank line to BE the directive, which is
what Next actually honours, and it explicitly records that an earlier substring
version passed with the directive deleted. But it reads only
`components/kit/*.tsx` and `components/nav/*.tsx`, one level deep, non-recursive.

The web-import guard is the **broader** one: three roots, recursive, `.ts` as
well as `.tsx` — but it accepts the directive on any line of its own, because
several console client modules open with a long comment before it.

So they overlap exactly on `components/kit` and `components/nav` `.tsx` files,
and that overlap is not redundant: on those files `use-client-boundary` catches
a misplaced directive that the web-import guard would accept. Dropping either
loses something. This is written into the widened file's header comment.

### Known limitation, stated rather than papered over

The import regex is unchanged (`from "@tesserix/web"`). It does not distinguish
`import type`, which is erased at compile time and harmless. No file does that
today, so it is not a live false positive — but a future type-only import from
the barrel in a server module would fail this guard with a misleading message. I
left the regex alone rather than add a carve-out that could also swallow real
value imports.

No exception list was added.

## #547 — the encoding bypass is now hard to reintroduce

### 1. Single-writer test — NEW

`apps/console/lib/auth/console-pathname-writer.guard.test.ts`. Walks the whole
console tree (skipping `node_modules`, `.next`, `public`; excluding `.test.` and
`.spec.` files) and asserts five things:

1. the walk reaches `middleware.ts` and `lib/auth/console-pathname.ts` (vacuity)
2. the only file matching `.set|.append(CONSOLE_PATHNAME_HEADER,` is `middleware.ts`
3. `middleware.ts` contains exactly **one** such call
4. that call's value argument is `consoleGatePathname(...)`
5. the literal `"x-console-pathname"` occurs in exactly one file — its declaration

(5) closes the hole in (2): a writer spelling the header by string literal would
not match the constant-based regex.

Test files are deliberately out of scope — `app/(console)/layout.access.test.tsx`
sets the header to drive the gate under test, which is the point of it, and a
test writer cannot reach a request.

### 2. Composition rows for encoded paths — ALREADY PRESENT, not duplicated

`lib/auth/console-pathname.test.ts` already exercises the composition
`capabilityForPath(consoleGatePathname(p))` through a `gate()` helper, over 20
tests: the three live-measured bypass paths, upper/lower-case escapes, an
encoded detail path, the undecodable cases (`%`, `%2F`, `%00`) each compared
against the raw `capabilityForPath` answer, single-decode (`%2525`), and the
four other dynamic routes with encoded values. I added nothing here; adding rows
would have been duplication.

### 3. Doc comment on `capabilityForPath` — doc only

`packages/console-core/src/route-access.ts`. A new
`# currentPath must already be percent-decoded (#543, #547)` section on the
existing JSDoc: names the literal-matching behaviour, the two-strings failure,
why normalisation is not done in `console-core` (pure route data that web and
mobile consume; `routeForPath`'s other callers already pass decoded router
params, so decoding here would double-decode them), and points at
`apps/console/lib/auth/console-pathname.ts`.

No signature change, no behaviour change, no new import. Verified before writing
it that `capabilityForPath` has no caller in `apps/web` or elsewhere in
`packages/` — the only production caller anywhere is
`apps/console/app/(console)/layout.tsx`.

## Mutation testing — every new assertion was proved to fail

Committed first, then mutated, then `git checkout --` to restore. (One edit was
lost the first time by doing that before committing; it was re-applied and
amended in.)

### #545 guard

**M1 — a `lib/*.ts` server module imports the barrel** (the exact case the old
`app/**.tsx` walk could not see). Appended to `lib/kpis.ts`:
`import { Badge } from "@tesserix/web";`

```
× server modules do not import @tesserix/web > lib/kpis.ts
  → lib/kpis.ts is a server module and imports @tesserix/web, whose barrel is
    "use client" — its exports will be undefined at render. Move the markup into
    a "use client" module beside it, as page-header.tsx does.: expected true to be false
  Tests  1 failed | 162 passed (163)
```

(163 there: the run predates the roots assertion added afterwards.)

**M2 — the walk is narrowed back.** `SOURCE_ROOTS` changed to `["app", "components"]`:

```
× server modules do not import @tesserix/web > walks app/, lib/ and components/
  → expected [ 'app', 'components' ] to deeply equal [ 'app', 'lib', 'components' ]
  Tests  1 failed | 83 passed (84)
```

This row exists because the per-module rows are *generated from* `SOURCE_ROOTS`:
dropping a root deletes its own coverage instead of failing it, which is exactly
how #545 happened. The per-root vacuity rows cannot catch that; this one does.

### #547 writer guard

**M3 — a second writer in another file.** Added to `app/(console)/layout.tsx`:
`export function __mutant(h: Headers, p: string) { h.set(CONSOLE_PATHNAME_HEADER, p); }`

```
× is written from middleware.ts and nowhere else
  → …: expected [ 'app/(console)/layout.tsx', …(1) ] to deeply equal [ 'middleware.ts' ]
  Tests  1 failed | 4 passed (5)
```

**M4 — a second `set` inside `middleware.ts`** (which M3's array check would not see):

```
× writes it exactly once within middleware.ts
  → expected 2 to be 1
  Tests  1 failed | 4 passed (5)
```

**M5 — middleware stops normalising**, i.e. the #543 bug restored verbatim:
`forwarded.set(CONSOLE_PATHNAME_HEADER, pathname)`

```
× normalises the value it writes
  → middleware.ts must pass the pathname through consoleGatePathname before
    setting the header — see lib/auth/console-pathname.ts.: expected false to be true
  Tests  1 failed | 4 passed (5)
```

**M6 — the header set by string literal**, bypassing the constant:
`forwarded.set("x-console-pathname", pathname)`

```
× spells the header name in one place only
  → expected [ Array(2) ] to deeply equal [ 'lib/auth/console-pathname.ts' ]
  Tests  1 failed | 4 passed (5)
```

**M7 — the walk root narrowed** (`path.resolve(__dirname, "..")`), so
`middleware.ts` falls out of scope:

```
× scans the files the writer and the declaration live in
  → expected [ 'ai-usage.ts', 'audit.ts', …(77) ] to include 'middleware.ts'
× is written from middleware.ts and nowhere else → expected [] to deeply equal [ 'middleware.ts' ]
× writes it exactly once within middleware.ts → Cannot read properties of undefined
× normalises the value it writes → Cannot read properties of undefined
```

The vacuity row fires first and names the cause, which is the point of it.

## Verification

- `pnpm --filter @tesserix/console-core build` — rebuilt before every console run
- `apps/console`: `lib/**`, `middleware.test.ts`, `app/(console)/layout.access.test.tsx`,
  both guards, `components/kit/use-client-boundary.test.ts` — **16 files, 476 tests, all pass**
- `packages/console-core`: 9 files, 154 tests, all pass
- `apps/console` `tsc --noEmit`: clean
- `apps/web` untouched; `console-core` runtime untouched (comment only)
