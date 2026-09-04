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
