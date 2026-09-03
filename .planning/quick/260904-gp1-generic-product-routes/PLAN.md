---
id: 260904-gp1
slug: generic-product-routes
date: 2026-09-04
issue: "#137 (retitled — see 'The issue is stale' below)"
kind: quick
---

# Generic `[product]` rail surfaces in the console

## The issue is stale, and this plan records how

`#137` was filed 2026-08-15 and last touched 2026-08-18. It asks to **collapse
duplicated `[product]` page wrappers** in the console, reading `apps/web`'s
already-generic `/api/admin/apps/[product]/*` API.

Three things are wrong with that, verified against `main` @ `83cbe94`:

1. **Every file it names is in `apps/web`, under `/admin/`.** `apps/console` has
   no `[product]` segment at all — its only dynamic routes are
   `crm/[organisation]`, `tickets/[id]`, `secrets/[...path]` and
   `secrets/reviews/[number]`. There is nothing to collapse. This is a build.

2. **The data path changed on 2026-08-29.**
   `docs/superpowers/specs/2026-08-29-admin-contract-v3-console-federation-design.md`
   (status: *approved for execution*) settles that the console reads products
   **only through platform-api**, against a closed endpoint vocabulary in
   `@tesserix/admin-conformance`. `apps/web`'s product API is not a source the
   console may use — `fetchEstateTenants`'s own docstring already says the
   tenant directory "deliberately has no apps/web fallback". Building #137 as
   written would add the dependency that design exists to remove.

3. **The four shapes are the wrong four.** "tenants → tenant detail → users" is
   already served estate-wide by `/platform/tenants`, a federated directory over
   every product. A per-product copy would be the same second door that got
   `kora.audit` and `kora.feedback` marked `retired`.

**One correction to the issue's own 08-18 comment**, which claimed Mark8ly has no
route ids: `mark8ly.migrationFastPath` exists (added by #406). Route ids by
prefix today are `platform` 36, `kora` 6, `mark8ly` 1. HomeChef, DevAI, Dwellm8
and HMS genuinely have none.

## What the generic shapes actually are

The contract's endpoint vocabulary, not `apps/web`'s page wrappers. Declared:

| Product | Declares |
|---|---|
| mark8ly | all 17 |
| kora | `audit-logs`, `entities`, `health`, `inbox`, `kpis` |

Two are declared by every conformant product and have **no generic console
route**:

| Shape | Contract id | platform-api route | Console today |
|---|---|---|---|
| Product overview | `kpis` | `GET /v1/kpis?source=` | Kora only, bespoke |
| Entity index | `entities` | `GET /v1/entities/{type}?source=` | Kora only, bespoke |

`fetchProductEntities(source, type, …)` (`lib/platform-api.ts:828`) is **already
fully generic**. Kora's pages are bespoke UIs over a generic fetcher. There is
**no `kpis` consumer in the console at all** — `fetchDashboard` reads
`WEB_ORIGIN`, which is the legacy path, not this.

`kpis`'s service doc names the consumer this plan builds: *"the overview backed
by this is a product-rail surface"*.

## Why it is worth doing

mark8ly declares `kpis` and `entities` and has **zero console rail**.
`mark8lyNav` is built and tested in console-core and rendered by nothing —
`estate.ts:197` says so in a comment; `sidebar.tsx`'s `RAILS` is a hand-built map
with two entries. A generic `[product]` route lights up mark8ly's overview and
its tenants/users surfaces **without a new page file**, which is acceptance
criterion 2 finally meaning something.

## THE ACCESS GATE — why the registry blocks the pages

`capabilityForPath` (`route-access.ts:76`) falls back to `ENTRY_CAPABILITY`
(`"read"` — the ticket every operator holds) for **any path no route id claims**.

So a generic `/[product]/…` route whose paths are not declared in `routes.ts`
would render a product's business KPIs to any operator holding only `read`. The
console-core registry is therefore not bookkeeping ahead of the pages; it is the
access control for them, and it must land first.

## Tasks

Each is one atomic commit.

### T1 — `console-core`: a first-class product notion

- `ProductId` (`"mark8ly" | "kora" | …`) sourced from the slugs `estate.ts`
  already carries, so there is one product list, not a second.
- `product?: ProductId` on `RouteEntry`, and the entity types each product
  exposes. `kpis`/`entities` support is per-product and must be declared —
  asking a product for an entity type it does not serve is a platform-api 400.
- A **derived** rails registry replacing `sidebar.tsx`'s hand-built `RAILS`.
- Route ids for the generic shapes per product (`mark8ly.overview`,
  `mark8ly.tenants`, `mark8ly.users`, …) so `capabilityForPath` gates them.
  Capability `platform`, matching every `kora.*` route.

Done when: `nav.test.ts` and `routes.test.ts` pass; a new product's rail is a
registry entry and no page file.

### T2 — wire `mark8lyNav` into the console sidebar

`RAILS` gains mark8ly, derived from T1 rather than hand-added. `estate.ts`'s
`migrated` comment for mark8ly is re-checked against what now renders.

Done when: the mark8ly rail appears and `estate.test.ts` still holds.

### T3 — `lib/kpis.ts` + `fetchProductKpis(source)`

`GET /v1/kpis?source=<slug>` returns `{ data: { [key]: scalar } }` — a flat map
of arbitrary keys to number | string | bool. Three states the parser must keep
distinct, all read from `kpis/internal/service/service.go`:

- **metrics** — a non-empty map. Render whatever keys come back; no per-product
  column config, which is what makes the surface generic.
- **not instrumented** — 501. *Kora answers 501 today* ("kora does not report
  business KPIs yet"), so this is live behaviour, not a hypothetical. It must
  render as its own state, never as dashes or zeroes — `dwellm8` rendered four
  em-dashes from launch for exactly this reason.
- **unreachable** — 5xx/DNS/TLS/timeout. Must NOT be reported as "not
  instrumented"; the service is explicit that this is the more dangerous of the
  two mistakes.

Unknown `source` is a 400 and never reaches here — T4 rejects it first.

Done when: unit tests cover all three states plus an empty `data` map (which
platform-api refuses upstream, so the console treats it as a decode error).

### T4 — `/(console)/[product]/page.tsx` + `not-found.tsx`

Generic overview from T3. **Validates `product` against the T1 registry and calls
`notFound()` otherwise** — acceptance criterion 3.

**Routing hazard to verify with a test, not by assertion.** `/platform/*` and
`/kora/*` are static segments and must keep winning over `[product]`. Next.js
prefers static at a given segment, but whether an unmatched *child* under a
static parent falls through to the dynamic sibling is behaviour I have not
confirmed. The registry check defends regardless — `platform` and `kora` are not
product-rail slugs, so a fall-through still renders not-found rather than a
wrong page — but the test pins it either way.

Done when: `/mark8ly` renders mark8ly's KPIs; `/kora` still renders the bespoke
page; `/nosuch` is not-found; `/platform/unknown` does not render this route.

### T5 — `/(console)/[product]/[entity]/page.tsx`

Generic entity index over `fetchProductEntities`, entity type validated against
the product's declared types from T1. Reuses `components/kit/*` and the existing
pagination envelope helpers.

Done when: `/mark8ly/tenants` and `/mark8ly/users` list rows; an undeclared type
is not-found; Kora's `/kora/foods` and `/kora/users` are untouched and still pass
their own tests.

## Not in this plan

- **Kora's four bespoke pages.** Untouched by decision. Static routes keep
  winning, so they need no change, and collapsing them rewrites ~320 LOC of
  shipped, tested surface for no user-visible gain. `/kora/ai-metrics` stays
  bespoke permanently — `koraaimetrics` is a deliberate named escape hatch.
- **Per-product tenants/users as a rail shape.** Ruled out above: `/platform/tenants`
  already serves the estate.
- **Retiring `apps/web`'s wrappers.** Gated on the console surface replacing
  them, and out of scope per the redesign design doc, which deletes
  `apps/web/app/admin` only once the last surface has moved.
- **Route ids for HomeChef, DevAI, Dwellm8, HMS.** They declare no contract
  endpoints, so a rail for them would link to 400s. They enter the registry when
  they declare.
