# T1 + T2 — the claim guard, and its four seeds

`apps/console/lib/claims.guard.test.ts`. Branch `test/console-claim-guard`,
worktree `th-wt-claims`. The shared `tesserix-home` checkout was not touched.

## What was built

`claim({ file, says, check })` pushes onto a module-level registry; three
`describe` blocks read it.

- **`the claim registry`** — vacuity. The registry is non-empty, and every
  registered `file` exists on disk.
- **`the comment is still there`** — one row per claim asserting `says` is still
  a substring of `file`. This is the ANCHOR, and it is a separate row from the
  fact, so the failure output distinguishes *the comment was reworded* from
  *the fact changed*.
- **`the fact it asserts is still true`** — one row per claim running `check`.

Helpers, all textual, all reading from `CONSOLE_ROOT` (`path.resolve(__dirname,
"..")`): `importersOf(module, dir)`, `occurrencesOf(needle, file)`,
`linesMatching(pattern, file)`. Nothing is `import()`ed — these are facts about
source, and importing a console server module would reach `pg`.

`importersOf` matches the module as the TAIL of a `from "…"` specifier, so `@/`
and relative spellings both count, and a comment that merely names the module
does not (several in this tree do).

**Cost.** 13 rows in **44ms** (315ms wall including vitest startup). The first
draft was 712ms because `importersOf` re-walked and re-read overlapping trees;
source reads are memoized in a `Map` and `walk` uses `readdirSync({
withFileTypes: true })` rather than a `statSync` per entry.

**No existing assertion was weakened.** `apps/web` untouched; `console-core`
runtime untouched. `lib/server-component-web-import.guard.test.ts` excludes
`.test.` files from its walk, so the new file does not trip it (confirmed by the
full run below).

## Verification

- `pnpm --filter @tesserix/platform-auth build` then `pnpm --filter
  @tesserix/console-core build` — required in that order; building console-core
  alone fails its DTS step with `TS2307: Cannot find module
  '@tesserix/platform-auth'`.
- `pnpm exec tsc --noEmit` — clean.
- `pnpm exec eslint lib/claims.guard.test.ts` — clean.
- `pnpm exec vitest run` (whole console) — **237 files, 4313 tests, all passing.**

## The seeds

### Seed 1 — `components/kit/entity-page.ts`

> "It lived under `kora/` while **Kora's three pages were its only callers**."

`check`: `page.tsx` files under `app/(console)/kora` importing
`components/kit/entity-page` number 3.

- **Count.** `importersOf` over `app/(console)/kora` returns seven files:
  `ai-metrics/{page.tsx, ai-metrics-view.tsx, ai-metrics-view.render.test.tsx}`,
  `foods/{page.tsx, food-index.tsx}`, `users/{page.tsx, user-directory.tsx}`.
  Filtering to `/page.tsx` leaves **3**: ai-metrics, foods, users.
- **Independent re-count.** `grep -rn entity-page app components lib test` from
  the console root, read by eye: the same three `page.tsx` paths, plus four Kora
  client views the sentence does not count, plus `[product]/[entity]/page.tsx`,
  `[product]/[entity]/entity-index.tsx`, the module's own test, and two prose
  mentions (`ai-metrics-view.tsx:363`, `onboarding/sessions/pager.ts:6`) that
  are not imports.
- Note on scope: the plan's sketch used
  `importersOf("kit/entity-page", "app/(console)/kora").length === 3`, which is
  **wrong for this sentence** — that population is 7. The sentence counts
  *pages*, so the check counts `page.tsx`. Recorded so the discrepancy with the
  plan is not read as drift.

### Seed 2 — `components/kit/entity-page.ts`

> "It moved here unchanged when **the generic entity index became a fourth**."

`check`: `page.tsx` importers across all of `app/(console)` number 4.

- **Count.** The three above plus `app/(console)/[product]/[entity]/page.tsx`
  = **4**.
- **Independent re-count.** From the same `grep` sweep, the `page.tsx` lines are
  exactly `[product]/[entity]/page.tsx:34`, `kora/users/page.tsx:15`,
  `kora/ai-metrics/page.tsx:9`, `kora/foods/page.tsx:16` — four.
- Seeds 1 and 2 share a population by nesting (2 ⊇ 1), so a mutation inside
  `kora/` reds both. This is visible in M1 below and is not a defect.

### Seed 3 — `app/(console)/[product]/[entity]/entity-index.tsx`

> "**The three `import type`s below** are not equally load-bearing…"

`check`: lines matching `/^import type /` in that file number 3.

- **Count.** `SurfaceState` (`components/kit/surface-state`), `EntityPage`
  (`lib/entities`), `PagerLinks` (`components/kit/entity-page`) = **3**.
- **Independent re-count.** `python3` regex `^import type ` over the file
  returns 3. Deliberately NOT counting inline `type` specifiers: the
  `filter-bar` value-import above carries two (`FilterDescriptor`,
  `FilterValues`), and counting those would give 5 for a sentence that
  enumerates statements.

### Seed 4 — `lib/platform-api.test.ts`

> "Unreachable today — **all 41 call sites are inside `it()` bodies** or helpers
> called from them…"

`check`: `occurrencesOf("installFetchStub(", …) === 41`.

- **Count.** 41. The trailing paren is load-bearing: it excludes the generic
  declaration (`function installFetchStub<T extends …>(`) and the error string
  (`"installFetchStub called outside a test scope…"`), so no subtraction is
  needed.
- **Independent re-count.** Bare `grep -c installFetchStub` = 43; minus the
  declaration and the error string = **41**. A third method,
  `grep -c '^[[:space:]]\+installFetchStub('` (indented call sites only), also
  returns **41**.
- Honest limit, stated in the registration: only the COUNT is machine-checkable.
  "inside `it()` bodies" is not, and the check does not pretend to verify it.

## Mutation proofs — 8 of 8, both directions per seed

Rows abbreviated; `×` = failed, `✓` = passed. Every mutation was reverted with
`git checkout -- apps/console` and the tree confirmed clean afterwards.

| # | Mutation | Result |
|---|---|---|
| M1 | FACT s1: add `app/(console)/kora/tmp/page.tsx` importing the module | `×` fact s1, `×` fact s2 (nested population), all 4 anchors `✓` |
| M2 | ANCHOR s1: "Kora's three pages" → "Kora's four pages" | `×` anchor s1; all 4 fact rows `✓` |
| M3 | FACT s2: add `app/(console)/platform/tmp-mutation/page.tsx` importing it | `×` fact s2 only (fact s1 `✓` — kora unchanged), all anchors `✓` |
| M4 | ANCHOR s2: "became a fourth" → "became a fifth" | `×` anchor s2 only; all fact rows `✓` |
| M5 | FACT s3: `import type { PagerLinks }` → `import { type PagerLinks }` | `×` fact s3 only; all anchors `✓` |
| M6 | ANCHOR s3: "The three \`import type\`s below" → "The 3 …" | `×` anchor s3 only; all fact rows `✓` |
| M7 | FACT s4: delete one `installFetchStub(fetchMock);` call site (line 1472) | `×` fact s4 only; all anchors `✓` |
| M8 | ANCHOR s4: "all 41 call sites" → "all 41 callsites" | `×` anchor s4 only; all fact rows `✓` |

M2/M4/M6/M8 are the ones that matter most: each rewords a comment while leaving
the code alone, and in every case the anchor reds while the fact stays green.
No registration survives the deletion of the sentence it describes.

## Claims from the plan's table that were NOT seeded

Searched for, not assumed from the plan's wording. In each case the sentence has
been reworded out of existence, and inventing a comment to register would be the
decorative-guard failure this change exists to prevent.

1. **"24 `mockResolvedValue(new Response(...))` sites"** — gone.
   `lib/platform-api.test.ts` has **3** `mockResolvedValue(new Response`
   occurrences today (lines 201, 209, 409); the stubbing was refactored behind
   `installFetchStub`. Its successor sentence in the same comment block *is*
   seeded, as seed 4.
2. **"the `afterEach` at :464 never calls `unstubAllGlobals`"** — gone. No
   comment in the console references an `afterEach` by line number. The file has
   two file-scope `afterEach` blocks, at lines 142 and 581.
3. **"`afterEach` in `describe(...)`"** — gone. `grep -rni "file-scope\|file
   scope\|column 0"` across `app/`, `components/`, `lib/` returns two unrelated
   hits (a task-scope note in `secrets/reviews/[number]/actions.ts`, a migration
   number in `db/crm-repo.ts`).
4. **"a value import would close a runtime cycle" (`nav.ts`)** — gone. There is
   no `nav.ts` in `apps/console` at all (the only one is
   `packages/console-core/src/nav.ts`), and `git log -S "runtime cycle"` over
   `apps/console` returns nothing. `grep -rn cycle` finds only `lifecycle`
   words plus two *different* cycle claims — `lib/billing/source-policy.ts:34`
   and `lib/db/crm-identity.ts:12` — neither of which is this one.

## Findings

**No seeded comment is wrong today.** All four values (3, 4, 3, 41) are correct
as shipped; no comment was modified.

Two observations, neither acted on:

- `lib/platform-api.test.ts:1449` says "this file's `afterEach` calls
  `vi.resetModules()`" — singular, but the file has **two** file-scope
  `afterEach` blocks and only the second (line 581) calls `resetModules`. The
  sentence is not false (an `afterEach` in this file does call it, and it does
  run before that test), only imprecise, so it was left alone. It is a
  reasonable fifth seed if someone tightens the wording first.
- `lib/search.ts:143` asserts "Uptime, Observability, Databases and Custom
  domains are exactly those four" — a countable claim outside the plan's table,
  and a good candidate for a future registration.

---

# Follow-up round — coordinator items 1, 2, 3

## 1. Re-rooted at the workspace; the `console-core` cycle claim is now seeded

**The correction to my own report.** I declined the runtime-cycle claim saying
"there is no `nav.ts` in `apps/console` at all". True, and beside the point. The
real reason was that `CONSOLE_ROOT = path.resolve(__dirname, "..")` pinned every
registration to `apps/console`, so no claim in `packages/` could be written at
all. The guard declined a claim for a reason that had nothing to do with the
claim — the exact silent-narrowing failure `server-component-web-import.guard`'s
own header warns about.

`WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..")`. Every registered
`file` and every `importersOf` directory is now workspace-relative
(`apps/console/…`, `packages/console-core/…`). A new vacuity row,
**"can reach packages/, not just apps/"**, asserts the registry spans both, so a
future re-narrowing fails loudly instead of quietly shrinking the domain.

**The file stayed at `apps/console/lib/claims.guard.test.ts`.** It needs the
console vitest project's `@tesserix/console-core` alias, which resolves the
package to its SOURCE rather than a possibly-stale `dist/`; standing up a second
vitest project at the workspace root to host one file would cost more than the
misfiling does. Recorded in the file's header, with the trigger for revisiting:
a second app registering claims.

### Seed 6 — `packages/console-core/src/routes.ts`

> "**NOT because of a cycle. There is none, and none is one edit away:**
> `routes → products → nav` is a tree, and `nav.ts`'s only reference back here
> is its own `import type { RouteId }`, which is erased too."

`check`: `nav.ts` has exactly one import from `"./routes"`, and it is
`import type`.

- **Count.** `packages/console-core/src/nav.ts:2` is
  `import type { RouteId } from "./routes";` — the only one.
- **Independent re-count.** `grep -n routes packages/console-core/src/nav.ts`
  returns 12 lines; 11 are prose mentions of `routes.ts` inside comments and one
  (line 2) is an import. `grep -c 'from "./routes"'` = **1**. No `require` and no
  dynamic `import()` of it anywhere in the file.
- Both halves of the check carry weight, and the registration says so: a
  multi-line value import fails too (its `} from "./routes";` line does not start
  with `import type`), and requiring *exactly one* stops the check passing
  vacuously if the import were deleted — the sentence names that import, so its
  disappearance is a rewording as well.

## 2. `platform-api.test.ts` — the singular is corrected, and pinned

I was wrong to leave this. Corrected in place; the comment now reads:

> "This file has TWO file-scope `afterEach` hooks, and only the second one calls
> `vi.resetModules()`. … Named as the second rather than as "this file's
> `afterEach`", which is what stood here: a reader who takes that singular
> literally finds the hook at the top of the file, which does NOT reset modules,
> and reasons about the wrong teardown."

### Seed 5 — `apps/console/lib/platform-api.test.ts`

`check`: exactly two file-scope `afterEach` blocks; the first does NOT contain
`vi.resetModules()`; the second does.

- **Count.** New helper `topLevelBlocks(name, file)` slices calls beginning at
  column 0 up to the next column-0 `});` — column 0 IS the distinction, since
  prettier indents anything inside a `describe`. Two blocks, at lines 142 and
  581.
- **Independent re-count.** `grep -c '^afterEach('` = **2**.
  `grep -n 'vi\.resetModules()'` returns three hits: line 583 (the real call, in
  the second block), line 700 (inside a comment), and the corrected comment
  itself. `awk 'NR>=142 && NR<=166' | grep -c resetModules` = **0**, confirming
  the first block does not call it.
- Deliberately not a count-only check: pinning "two hooks" alone would stay green
  if `resetModules` moved to the FIRST hook, which is precisely the misreading
  the corrected wording exists to prevent. M9 below proves it fails on exactly
  that.

## 3. Seed 7 — `apps/console/lib/search.ts`

> "**Uptime, Observability, Databases and Custom domains are exactly those
> four**; `/platform/health` now names three of them in prose…"

`check`: the pending routes with no rail entry are exactly
`platform.uptime`, `platform.observability`, `platform.databases`,
`platform.customDomains`.

- **Count (method 1, computed).** Recomputed from `@tesserix/console-core` the
  way `search.ts` derives `RAILED_ROUTES` —
  `ROUTE_IDS.filter(id => isPending(id) && !railed.has(id))` where `railed` is
  every `navItems(railNav(id))` route over `RAIL_IDS` — giving exactly those
  four, out of 46 route ids and 14 pending. NOT by importing `search.ts`, which
  would test the check against the code it checks.
- **Count (method 2, textual and independent).** Comments stripped, then route
  entries parsed out of `routes.ts` by regex and rail entries out of `nav.ts`
  (`route: "…"`): 13 pending, 34 railed, orphans = the same four, in the same
  order the prose lists them.
  The two methods disagree on the pending TOTAL — 14 vs 13 — because the
  one-line regex misses `mark8ly.migrationFastPath`, which is declared across
  several lines. Chased rather than waved away: that route **is** railed, so it
  is not an orphan and the orphan sets agree exactly. Recorded because "the
  numbers nearly match" is how a wrong count survives.
- This is the one `check` that computes from a package rather than reading
  source text: the fact is a JOIN of the route table's `pending` flag against
  every rail's items, which no grep expresses honestly. `console-core` is a pure
  data package imported statically at the top of the guard; the "never
  `import()`" rule is about the module UNDER INSPECTION, and the file under
  inspection here (`search.ts`) is still only read as text. The distinction is
  written into the guard's header.

## A design change the anchor forced on me

Seed 7's first registration **failed its own anchor**: the sentence wraps across
two source lines, and a naive `includes` cannot see it. The guard caught my
error, which is the intended behaviour, but the general case is a false
positive — re-wrapping a paragraph would red an anchor without changing a word.

`flatten(text)` now strips comment markers (`*`, `//`) and collapses all
whitespace, and is applied to BOTH sides of the anchor comparison. An anchor may
be quoted on one line however the source breaks it, and re-wrapping is not a
rewording. Rewording still reds: M10, M12 and M14 below each change one word and
each fails.

## Mutation proofs — the six new ones, plus two re-rooting regressions

Same protocol: mutate, run, revert with `git checkout --`, confirm a clean tree.
Every row not listed passed; test totals were read on each run so a collection
error could not masquerade as "no failures".

| # | Mutation | Result |
|---|---|---|
| M9 | FACT s5: give the FIRST file-scope `afterEach` a `vi.resetModules()` too | `×` fact s5 only (1 failed / 22 passed) |
| M10 | ANCHOR s5: "only the second one" → "only the last one" | `×` anchor s5 only |
| M11 | FACT s6: `nav.ts` `import type { RouteId }` → `import { type RouteId }` | `×` fact s6 only |
| M12 | ANCHOR s6: "NOT because of a cycle" → "Not because of a cycle" | `×` anchor s6 only |
| M13 | FACT s7: drop `pending: true` from `platform.databases` (three orphans, not four) | `×` fact s7 only (1 failed / 22 passed) |
| M14 | ANCHOR s7: "are exactly those four" → "are exactly those 4" | `×` anchor s7 only |
| M2′ | ANCHOR s1 re-run after re-rooting: "three pages" → "four pages" | `×` anchor s1 only |
| M7′ | FACT s4 re-run after re-rooting: delete one `installFetchStub` call site | `×` fact s4 only (1 failed / 22 passed) |

**Two mutations misfired on the first attempt and are recorded rather than
quietly re-run.** M13's first perl dropped the captured group as well as
`pending: true`, corrupting `routes.ts` so the guard failed to COLLECT — and my
grep filtered for `×` rows only, so a total collection failure printed as "all
other rows passed". M7′'s first attempt deleted line 1472, which was no longer
an `installFetchStub` line after the item-2 comment edit shifted the file by
nine lines. Both were rerun against the right targets, and the harness now
prints `Test Files` / `Tests` totals on every mutation so an empty failure list
cannot be mistaken for a passing run. This is the same defect class the guard
exists for: a check that reports green for a reason unrelated to the thing it
claims to check.

## Final verification

- `pnpm --filter @tesserix/platform-auth build` → `pnpm --filter
  @tesserix/console-core build` (order matters, see below).
- `apps/console`: `tsc --noEmit` clean, `eslint` clean on both changed files,
  `vitest run` → **237 files, 4323 tests, all passing** (up from 4313: the 10
  new guard rows).
- `packages/console-core`: `test:unit` → **9 files, 154 tests passing**;
  `typecheck` and `lint --max-warnings 0` clean. Run because the item-1 seed
  reads `console-core` source and the M11/M13 mutations touched it.
- Guard cost: **23 rows in 53ms** (477ms wall including vitest startup).

## Repo trap worth an issue: `console-core`'s build needs `platform-auth` first

`pnpm --filter @tesserix/console-core build` fails on a clean checkout:

```
DTS Build start
src/route-access.ts(29,33): error TS2307: Cannot find module
  '@tesserix/platform-auth' or its corresponding type declarations.
Error: error occurred in dts build
```

The JS bundles (CJS + ESM) build fine — only the DTS step fails, because
`route-access.ts` type-imports `Capability` from `@tesserix/platform-auth` and
tsup's dts worker resolves it through the sibling package's `dist/`, which does
not exist until that package is built. `pnpm --filter @tesserix/platform-auth
build` first, and console-core builds clean.

Two things make this worth writing down rather than remembering: the error names
a module that IS correctly declared as a dependency, so it reads like a broken
install rather than an ordering problem; and the two JS "Build success" lines
print immediately above the failure, so a truncated log looks like a success.
Suggested follow-up: give `console-core`'s `build` script a dependency on
`platform-auth`'s (a `turbo`/`pnpm` topological `^build`), so the ordering is
declared rather than folklore.

## Standing summary

**7 seeds**, each counted by two independent methods and mutation-proved in both
directions (14 mutations, all isolated to the intended row except the nested
entity-page pair, M1, which is explained above).

**One comment corrected**: the singular `afterEach` at
`apps/console/lib/platform-api.test.ts`. No other comment was modified, and no
seeded value was found wrong.

**Still declined** (reworded out of existence; unchanged from the first round,
except that the cycle claim moved from declined to seeded): the "24
`mockResolvedValue`" sentence, the `afterEach at :464` sentence, and the
"`afterEach` in `describe(...)`" sentence. Four of the original six claims are
now pinned — seeds 1, 3, 5 (successor form) and 6.

---

# Review round — two false claims inside the guard itself

The reviewer found that `claims.guard.test.ts` made two false mechanism claims
in its own header. That is this guard's defect appearing inside this guard, on
the third pass, by the author it was built to catch. Both are fixed, and the
file now records that they were wrong rather than quietly reading as if they had
always been right.

## 1. `:48` — "the registry cannot silently outlive the sentence it describes"

False. The anchor matched text ANYWHERE in the file. Three disproofs, all
reproduced here:

| attack | before | after |
|---|---|---|
| delete the sentence from the comment, re-add the words as `export const NOTE = "…"` | 23/23 green | **reds** |
| `"…became a fourth"` → `"…became a fourth, and a fifth and a sixth followed"` | green | still green — unfixable, now stated |
| `"while Kora's three pages…"` → `"while it was never true that Kora's three pages…"` | green | still green — unfixable, now stated |

### (a) What was closed

New `commentText(file)` collects only WHOLE-LINE comments — a line whose trimmed
form opens with `//` or `/*`, or that sits inside a block comment — and the
anchor now matches against that instead of the raw file.

Whole-line only, deliberately. Recognising a trailing `// note` after code means
knowing the `//` is not inside a string or a regex literal, which needs a real
tokenizer; every comment worth anchoring in this repo is a block above the thing
it describes. The restriction is stated at the function and in the anchor's
failure message, so an anchor placed in a trailing comment fails with an
explanation rather than a puzzle.

### (b) What is stated instead

The header now separates the two, under **"EXACTLY what the anchor guarantees,
and what it does not"**:

- **GUARANTEED** — the exact words of `says` still appear, in order, inside a
  comment in `file`. Deleting, rewording, or moving them out of a comment reds.
- **NOT GUARANTEED, and unfixable by substring matching** — text added AROUND
  the anchor. A negation prefixed to it or a continuation appended to it leaves
  the words intact. "The anchor pins the words, not their meaning in the
  surrounding sentence, and a bigger regex does not change that — it only moves
  the boundary somewhere less obvious. `check` is what defends the FACT."

The header also names where the false version came from, so the correction is
not silently absorbed.

## 2. `:331` — the vacuity rationale

It claimed a registry pointing at missing files "passes every row below while
checking nothing". False: renaming a registered path reds the `exists` row AND
throws ENOENT out of `read` in the anchor row — two loud failures.

Corrected in place. Only the EMPTY case is silent (`it.each([])` generates no
rows), so `it("is not empty")` is the row that actually earns its place. The
`exists` row is kept for the failure OUTPUT, not for coverage: it names the
registration and the path, where the bare ENOENT is a stack trace out of a
helper. That reason is now what the comment says.

## 3. Two checks narrower than their sentences — both widened

**Seed 3** now counts `^import type ` only BELOW the anchor, via a new optional
`after` parameter on `linesMatching` (a marker that is absent yields no lines,
so a broken marker reds rather than silently widening back to the whole file).

I first justified this with a claim that was itself false — that "an `import
type` added above the comment would keep the file-wide count at 3". It would
not; an addition reds either version. The discriminating case is a **move**, and
M17 below demonstrates it: relocating one of the three above the comment leaves
the file-wide count at **3** (green, wrongly) while the scoped count is 2 (reds,
correctly). The corrected comment says so, and says the earlier sentence was
wrong until the mutation disagreed. Third false mechanism claim of this task,
caught this time by running the mutation before writing the sentence down.

**Seed 6** now also rejects a runtime `require("./routes")` or dynamic
`import("./routes")` in `nav.ts` — references no `from` clause would show, and
the only thing the sentence actually promises is absent from the runtime graph.
Previously cleared by hand; now checked.

## 4. Left alone, as directed

The header's survey numbers (242 count-claim hits, 42 `file:line` refs, 0 stale)
are now explicitly framed: *"Measured on 2026-09-04, and these are that day's
survey rather than standing facts"*, with a note saying they are deliberately
NOT pinned because a guard on them would fail on unrelated edits. Also left:
seed 1's "only callers" being historical, seed 4 not claiming `it()`
containment, and the file living in `apps/console/lib/`.

## Mutation proofs for this round

| # | Mutation | Result |
|---|---|---|
| ATTACK | delete the anchored sentence, re-add the words as `export const NOTE = "…"` | **`×` anchor s1 only** (1 failed / 22 passed) — the attack now reds |
| M15 | same shape on seed 7: sentence reworded, words survive only in a string literal | `×` anchor s7 only |
| M16 | POSITIVE CONTROL: re-wrap the seed-1 sentence across different lines *inside* the comment | **23/23 green** — comment scoping did not break legitimate re-wrapping |
| M17 | FACT s3: MOVE one `import type` above the anchor (file-wide count verified still 3) | `×` fact s3 only |
| M18 | FACT s6: `void import("./routes")` added to `nav.ts` | `×` fact s6 only |

M18's first attempt used `require("./routes")` and the run reported
**"Tests no tests"** — the module failed to resolve under ESM, so nothing
collected. Caught by the totals line added last round; rerun with valid ESM. A
CJS `require` cannot exist in this package anyway, so the dynamic `import()`
form is the one that matters.

## Final verification

- `apps/console`: `tsc --noEmit` clean, `eslint` clean on both changed files,
  `vitest run` → **237 files, 4323 tests, all passing**.
- `packages/console-core`: `test:unit` → 9 files, 154 tests passing;
  `typecheck` and `lint --max-warnings 0` clean.
- Guard: **23 rows, 87ms**.

## Where this leaves the count

**7 seeds**, unchanged — the review confirmed every value, including the
reconciliation on the pending-route total (the reviewer's brace-matching parse
of `routes.ts` gives 14 pending and the same four orphans; my textual 13 was the
one-line-regex miss I recorded, and the orphan conclusion was right).

**Comments corrected across the whole task: four.** One in
`platform-api.test.ts` (the singular `afterEach`), and three inside
`claims.guard.test.ts` itself — the anchor guarantee, the vacuity rationale, and
the seed-3 justification. Every one of the three was a mechanism claim asserted
without running the command that would have checked it, which is precisely the
defect in the plan's table. That the guard's own header was the last place it
appeared is worth keeping in the record.

---

# Re-review round — three more false claims, and the prose cut

All three reproduced before anything was rewritten. Commands and output below.
That makes **five false mechanism claims produced by this one file**, and
eleven across the session. The response is not another round of corrections: the
file now carries only sentences I ran a command to verify.

## The three corrections, each with the command and its output

### 1. Seed 3's parenthetical — "an addition above the comment reds either version"

```
$ perl -pi -e 's|^// THE RULE:|import type { ReactNode } from "react";\n// THE RULE:|' \
    'app/(console)/[product]/[entity]/entity-index.tsx'
$ grep -c '^import type ' 'app/(console)/[product]/[entity]/entity-index.tsx'
4
$ pnpm exec vitest run lib/claims.guard.test.ts
      Tests  23 passed (23)
```

File-wide count **4** (a file-wide check would red); scoped check **green**.
False as written — the addition *does* discriminate, and what it shows is the
file-wide count FALSE-ALARMING, not the scoped one missing.

The comment now states both discriminating cases with their measured numbers:
an **addition** above the anchor gives file-wide 4 / scoped green (false alarm),
a **move** gives file-wide 3 / scoped reds (miss). The move was re-measured on
the final file: `file-wide count: 3`, `Tests 1 failed | 22 passed (23)`.

### 2. The vacuity comment — "`it.each([])` … this row is the only thing standing between that and a green suite"

```
$ # CLAIMS emptied, `is not empty` skipped
$ pnpm exec vitest run lib/claims.guard.test.ts
   × the claim registry > can reach packages/, not just apps/ 4ms
Error: No test found in suite the comment is still there
Error: No test found in suite the fact it asserts is still true
      Tests  1 failed | 1 skipped (2)
```

Three failures, not silence. False on both halves. The comment now says what was
observed: vitest reds with `No test found in suite` for both describes AND
`can reach packages/` fails, so the empty case is not silent and this row is not
what catches it — it is there to name the cause in one line.

The `exists` row's rationale was re-measured the same way:

```
$ mv lib/search.ts lib/search-renamed.ts && pnpm exec vitest run lib/claims.guard.test.ts
 → apps/console/lib/search.ts is registered but is not on disk: expected false to be true
 → ENOENT: no such file or directory, open '.../apps/console/lib/search.ts'
```

Two failures — the named row and the ENOENT. Kept for the message, not coverage,
and the comment says exactly that.

### 3. "cannot be fooled by a `//` inside a string" / "moving the words into a string literal does not satisfy it"

```
$ # anchored sentence removed from the comment; words re-added as
$ #   export const NOTE = `
$ #   // It lived under kora/ while Kora's three pages were its only callers.
$ #   `;
$ pnpm exec vitest run lib/claims.guard.test.ts
      Tests  23 passed (23)
```

Green. `commentText` reads lines, not tokens, so a template literal whose lines
begin with `//` satisfies the anchor. The unqualified GUARANTEED is gone; the
header now lists this as a measured GREEN case beside the others.

## Every header statement re-measured against the FINAL file

The header's table is now six measured outcomes, each re-run after the rewrite:

| edit | expected | observed |
|---|---|---|
| reword the sentence | REDS | `1 failed \| 22 passed (23)` |
| words moved to a bare string literal | REDS | `1 failed \| 22 passed (23)` |
| words moved to a trailing comment after code | REDS | `1 failed \| 22 passed (23)` |
| re-wrap the paragraph | GREEN | `23 passed (23)` |
| prefix "It was never true that" | GREEN | `23 passed (23)` |
| template literal whose lines begin with `//` | GREEN | `23 passed (23)` |

One process note. The negation row first "passed" from a shell heredoc in which
backtick expansion ate the perl pattern — the run printed
`no such file or directory: kora/` and `23 passed`, which looks identical to a
real green. Rerun through a Python file that asserts the pattern was found and
echoes the rewritten line before testing. A GREEN result from a mutation that
did not apply is indistinguishable from a GREEN result from one that did, and it
is the same masking as the `Tests no tests` case two rounds ago.

## The prose cut

Rule applied: a sentence asserting behaviour is either pinned by a row in this
file, measured by a command whose output is in this report, or deleted.

```
before: 476 lines (232 comment / 244 code), 124 comment sentences
after:  355 lines (113 comment / 243 code),  76 comment sentences
deleted: 119 comment lines, 48 sentences
```

**Comment volume halved (232 → 113); code is untouched (244 → 243).** Deleted:
the narrative about rejected alternatives, the history of each earlier draft and
its correction, the "why a test and not a comment" framing, extended mechanism
explanations, and every self-referential aside about which round found what.
That history lives in the plan and in this report, which is where it belongs.

Kept, because a reader needs it to use or edit the thing: what `claim()` does,
what `says` anchors against, the GUARANTEED / NOT-GUARANTEED boundary as a
measured table, one rule list for writing a registration, and per seed the
counting method and why the check is shaped as it is. `topLevelBlocks` was also
moved up beside the other helpers rather than sitting below the registry.

The one durable instruction added, because it is the only practice in this task
with a track record: **"Run the mutation before writing the sentence that
describes it."** Ten of the eleven false claims were caught by a reviewer; the
one caught by the author was caught that way.

## Final verification

- Guard: **23 rows, 43ms**, 355 lines.
- `apps/console`: `tsc --noEmit` clean, `eslint` clean, `vitest run` →
  **237 files, 4323 tests passing**.
- `packages/console-core`: 9 files / 154 tests passing, `typecheck` and
  `lint --max-warnings 0` clean.
- Tree clean after every mutation; each reverted with `git checkout -- .` and
  the revert confirmed.

## Standing totals

**7 seeds**, values unchanged and confirmed by the reviewer's independent parse.
**Comments corrected across the task: seven** — one in `platform-api.test.ts`
(the singular `afterEach`), and six in `claims.guard.test.ts` itself (the anchor
guarantee, the vacuity rationale, the seed-3 justification, the seed-3
parenthetical, the `it.each([])` claim, and the string-literal guarantee).

Five of those six were mechanism claims asserted without running the command
that would have checked them — inside the file built to catch exactly that. The
file no longer contains a sentence about its own behaviour that has not been
run.
