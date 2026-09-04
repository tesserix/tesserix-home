# T3 — #546: an unfederated product reads as "not switched on"

Console-only, as the plan's correction said. `platform-api` untouched.

## What was wrong

`platform-api` scopes its federated reads to this deployment's declarations and
refuses anything outside that scope with **400**, which `resolveState` renders
as `error` — an outage-shaped page for a system working exactly as configured.
Verified in the Go source rather than taken from the issue:

| module | cause | file | status |
|---|---|---|---|
| `kpis` | `ErrNoProducts` — `len(s.slugs) == 0`, checked **before** `source` | `kpis/internal/service/service.go` | 501 |
| `kpis` | `ErrUnknownSource` — list non-empty, slug not in it | same | **400** |
| `entities` | `ErrNotInstrumented` — `len(s.types) == 0` | `entities/internal/service/service.go` | 501 |
| `entities` | `ErrUnknownSource` — slug is not a key of `types` | same | **400** |
| `entities` | `ErrTypeNotServed` — slug is a key, type not declared | same | **400** |

Only the 501 rows read calmly. The likelier deployment (kora federated,
mark8ly not) is a 400 row.

## Before-vs-after: the two surfaces differ, and the API is why

**`[product]/[entity]` checks BEFORE the read.** `main.go` builds
`entities.Config.Types` and `sources.Config.Entities` in two adjacent blocks
from the same `product.Entities`, and `sources`' service inverts that map
without filtering. So `slugsServing(sources, type).includes(slug)` is the very
condition `service.Read` gates on — not a proxy for it. The gate is exact in
both directions, so the page skips the request entirely, which is the shape
`/platform/onboarding` established.

**`[product]` interprets a 400 AFTER the read.** It cannot check first.
`/v1/platform/sources` is the inversion of `FEDERATION_<SLUG>_ENDPOINTS` and
`_ENTITIES`, and `registry.go` marks **both optional**, while `/v1/kpis` is
scoped to `FEDERATION_PRODUCTS` itself — which `sources` does not expose. A
federated product declaring no endpoints and no entity types is therefore
absent from `sources` while its KPIs read perfectly well, and a
check-before-read would print "not federated" over real numbers. So the page
requires a **conjunction**: the API refused this slug with 400 **and** the
declarations mention it nowhere. Neither half alone is sufficient, and both
halves are pinned by a test.

The declarations are read **in parallel** with the KPIs (`Promise.allSettled`),
so the interpretation costs no round trip. The entity page's check is serial by
necessity — the answer is a precondition of the read.

A failed sources read is `null`, never `declared: false`, on both surfaces: the
absence of a fact is not the fact that nothing is declared, which is what
`fetchPlatformSources`' own comment demands. On `[product]` that leaves the 400
rendered as the failure it was; on `[product]/[entity]` the page falls through
and reads exactly as it did before this gate existed.

## No new `SurfaceState` kind

`instrumentation-unavailable` already means "off, not broken", and its
`title`/`message` overrides exist because "not wired up yet" has more than one
cause with more than one remedy — the union's own comment says so. This is that
state with a config-shaped remedy, like `KPIS_UNAVAILABLE_*`. Copy points at the
deployment's federation configuration, never at `docs/observability-park.md`.

## Files

- `apps/console/lib/platform-sources.ts` — added `slugsServing` (the entity
  twin of `slugsDeclaring`) and `declarationsMention` (a documented **lower
  bound**, not a membership test).
- `apps/console/app/(console)/[product]/federation-scope.ts` — **new**: the
  copy, `BAD_REQUEST`, and the shared state builder.
- `apps/console/app/(console)/[product]/page.tsx` — parallel sources read;
  `overviewState` gains an optional third argument (existing two-argument calls
  keep their exact previous behaviour, so no existing assertion was weakened).
- `apps/console/app/(console)/[product]/[entity]/page.tsx` — sources gate before
  the read.

15 new tests (4 + 8 + 3). No existing test changed.

## Removal proofs — every new test, removed / observed / restored

Files were backed up to the scratchpad first and restored from the backups
(never `git checkout`, which would have discarded the uncommitted work).

| # | what was removed | rows that went red |
|---|---|---|
| M1 | the not-federated branch in `overviewState` | `maps a 400 … to the not-federated state`; `renders a 400 from an unfederated product calmly` |
| M2 | the `!federation.declared` half | `leaves a 400 an error when the declarations mention the product` |
| M3 | `federation !== null` (unread ⇒ undeclared) | `leaves a 400 an error when the declarations could not be read`; `still shows the failure when the declarations could not be read` |
| M4 | the `status === BAD_REQUEST` half | `leaves a 503 an error even for a product nothing declares`; `leaves a 501 on the KPI copy even for a product nothing declares` |
| M5 | `allSettled` → `all` (a failed sources read is fatal) | `renders the metrics when the declarations read fails but the KPIs arrive` (+4 collateral) |
| M6 | the `if (federated !== false)` read gate | `renders an unfederated product calmly, and makes no read at all`; `covers a federated product that did not declare THIS type` |
| M7 | the calm-state ternary in the entity page | same two rows |
| M8 | `null` ⇒ not federated on the entity page | `reads anyway when the declarations could not be read` |
| M9 | `slugsServing` reads `endpoints` | `reads the entities map, not the endpoints one` |
| M10 | `declarationsMention` searches `endpoints` only | `is true for a slug named in either map` |
| M11 | `slugsServing`'s `?? []` fallback | `treats a type nobody serves as no products` (+M9's row) |
| M12 | `declarationsMention` always true | `is false for a slug nothing declares, and for an empty estate` |

Each was restored immediately and the file re-run green before the next.

## Commands

```
$ pnpm --filter @tesserix/console-core build
DTS ⚡️ Build success in 239ms

$ pnpm vitest run "app/(console)/[product]" lib/platform-sources.test.ts lib/server-component-web-import.guard.test.ts
Test Files  9 passed (9)
Tests  269 passed (269)          # includes the widened guard's 165 rows

$ pnpm typecheck                 # tsc --noEmit, clean
$ pnpm lint                      # eslint --max-warnings 0, clean

$ pnpm vitest run
Test Files  234 passed (234)
Tests  4277 passed (4277)
```

## #546 MUST NOT BE CLOSED

This task stops the console **rendering** the refusals wrongly. The wire is
unchanged and the Go half of #546 stands:

- `ErrUnknownSource` is still a **400** on both modules, and `ErrTypeNotServed`
  with it.
- A product answering an empty metrics map `{}` still reaches the console as
  **503** — `service.go` returns a bare `fmt.Errorf` for `len(envelope.Data) == 0`
  and `writeReadError`'s switch falls through to `default` → `httpx.Unavailable`.
  §3.1 requires 501 for that deviation. Nothing here touches it.

Kora's bespoke pages (`app/(console)/kora/*`) have the same gap and were left
alone, per scope.

---

# Review round 2 — the four items

## 1. The false mechanism (merge condition) — corrected in both places

The prose was wrong; the parenthetical was right. Re-derived from source, not
from the description:

- `main.go:218-223` — `for _, slug := range cfg.Federation.Slugs() { if product,
  ok := cfg.Federation.Get(slug); ok { types[slug] = product.Entities } }`.
- `registry.go:141-148` — `Slugs()` ranges `r.byslug`'s keys; `registry.go:93-96`
  — `Get` looks up the same `byslug`. So the `ok` guard never skips a slug, and
  a key is written for **every federated product** whatever its `Entities`.
- `registry.go:205-211` — `Entities` and `Endpoints` are both `splitList(...)`
  of an optional env var.

Therefore `len(s.types) == 0` ⟺ **this deployment federates nothing at all**. A
deployment federating mark8ly with `FEDERATION_MARK8LY_ENTITIES` unset has
`len(types) == 1`, `known == true`, and answers **400 `ErrTypeNotServed`** — not
501. Both comments now say that, and the entity page's adds the sentence the
failure scenario asked for: *"the 501 path does NOT already cover these.
Deleting the gate below as redundant would put that page back."*

## 2. Parallelised — and it held up, with one correction and one dead clause found

`fetchPlatformSources` goes through `request()`, which sets `cache: "no-store"`
(`lib/platform-api.ts:468`), so the serial version was a real added hop on the
common path. Both reads now go out in one `Promise.allSettled`.

Two things the implementation showed that the plan for it did not:

- **The gate must not override real rows.** With the read now issued anyway, a
  successful 200 from a slug the declarations call undeclared became a reachable
  combination in code. Rendering "not switched on" over rows that exist is the
  dangerous direction — the same mistake as rendering a 503 as "no metrics" — so
  the calm state requires `federated === false` **and** the read not coming back.
  New test: `shows real rows even when the declarations say the slug is
  undeclared`.
- **Suppressing the explained refusal was dead code.** I first wrote `error =
  notFederated || ... ? null : reason`. Mutation P4 removed the `notFederated ||`
  and **nothing went red** — because the calm branch renders without calling
  `entityState`, so that value is never read. A clause no test can distinguish is
  not doing work, so it was removed rather than kept with a comment implying
  behaviour that is not there.

Stale prose from the serial design was corrected in four places rather than left
to rot: the entity page's *"the request is not made at all"* heading, the
overview page's *"AFTER the KPI read, not before it"* heading and its
`[entity]` cross-reference, and `slugsServing`'s *"lets a caller avoid the 400"*.
The distinction between the two surfaces is now stated as what it actually is —
exact gate vs lower bound needing corroboration — not as read ordering.

## 3. Aggregate vacuity added

Counted, twice, with a script: `app` 75, `lib` 79, `components` 7 = **161**
recursive server modules; top-level-only would be 1 + 40 + 3 = **44** — matching
the reviewer's figures exactly. Added
`expect(SERVER_MODULES.length).toBeGreaterThan(100)` with those numbers in the
comment.

## 4. `middleware.ts` added — cleanly, without dragging in `dev/`, `test/`, `scripts/`

A `SOURCE_FILES` list beside `SOURCE_ROOTS` rather than a fourth root: the walk
is untouched, and `dev/`, `test/` and `scripts/` stay out. The equality
assertion covers it too, so dropping it is a deliberate edit. `middleware.ts`
has no `"use client"` and does not import `@tesserix/web`, so it enters as a
checked server module and passes.

## Round-2 removal proofs

| # | what was removed | result |
|---|---|---|
| P1 | `walk()` made non-recursive | **only** `checks the whole tree, not just its top level` went red; all three per-root rows stayed green and the file fell from 167 rows to 49 — the exact blind spot the reviewer described |
| P2 | `middleware.ts` from `SOURCE_FILES` | `walks app/, lib/ and components/` red; row count 167 → 166 |
| P3 | the `fetched === null` half of `notFederated` | `shows real rows even when the declarations say the slug is undeclared` red |
| P4 | the `notFederated \|\|` error suppression | **nothing red** — clause proven dead, and removed |
| P5 | the `federated === false` half of `notFederated` | three rows red, incl. `keeps a 400 an error on a slug the deployment DOES declare` |

## Round-2 commands

```
$ pnpm typecheck            # tsc --noEmit, clean
$ pnpm lint                 # eslint --max-warnings 0, clean

$ pnpm vitest run "app/(console)/[product]" lib/platform-sources.test.ts lib/server-component-web-import.guard.test.ts
Test Files  9 passed (9)
Tests  273 passed (273)

$ pnpm vitest run
Test Files  234 passed (234)
Tests  4281 passed (4281)     # 4277 + 2 entity rows + 2 guard rows
```

19 new tests across T3 and the two guard additions. #546 still must not be
closed — the Go half is unchanged.
