# The internal tools directory, in the database

**Status:** approved — no open decisions in this phase. Two decisions are
deferred to Phase 2 and named at the end.
**Issue:** #318, Phase 1 only.
**Goal:** the console's internal tools directory is read from `tesserix_admin`
through the Go platform API, and a tool link can be added, edited, reordered or
removed without a deploy.

## The pain, stated precisely

The console home page fetches nothing. Its internal-tools section is rendered
from two literals in `packages/console-core/src/tools.ts`: `INTERNAL_TOOLS`
(fifteen rows, line 53) and `TOOL_GROUPS` (five groups, line 42). Adding a tool
link is therefore a code change, a review, a CI run and a deploy — for a row of
directory data with no security property and no validation depending on it.

That is the whole of the pain, and it is worth fixing. It is also the *safe*
half of #318: the estate half carries a DPDP gate and a CRM validation
vocabulary, and neither moves here. See "What does not move".

## What moves

| Today | After |
|---|---|
| `INTERNAL_TOOLS` literal | `platform_tools` rows |
| `TOOL_GROUPS` literal | `platform_tool_groups` rows |
| `toolUrl()` host derivation | unchanged, in code |
| `toolsInGroup()` | unchanged in shape, fed from fetched rows |

## What does not move, and must not

Restated here so it cannot drift during implementation:

- **`EstateProduct.endUserLookup`.** A DPDP gate that defaults to false by
  absence, where the absence *is* the mechanism. `estate.test.ts:82` fails the
  day a product opts in. A CRUD form over it would flip it with no commit, no
  reasoning beside it and no failing test.
- **The `ESTATE` context list.** It is a validation vocabulary, not a card list:
  `crm/organisations/new/actions.ts:28` and `[organisation]/actions.ts` build
  `ESTATE_CONTEXTS` from it to validate `product` on CRM writes. Deleting a row
  through CRUD would not remove a card; it would make existing opportunities
  unwritable.
- **Any `platform_estate` table.** Phase 2, if it happens at all.

## Decisions taken

### D1. The database is canonical; the code literal is a labelled fallback

`platform_tools` is the source of truth. `INTERNAL_TOOLS` stays in
console-core and is rendered when the platform API cannot be reached, so the
directory survives an outage.

The accepted cost of a fallback is that two lists can disagree. It is accepted
but **not silently**: the loader returns a `source` discriminator and the cards
render a quiet line — *live directory unavailable, showing the built-in list* —
when it is `"builtin"`. This is the same instinct as the "DELIBERATELY NO
STATUS" rule already at the top of `tools.ts`: nothing renders as measured when
it was not.

### D2. The group vocabulary moves too

`platform_tool_groups` carries key, label and display order. This gives up the
compile-time `ToolGroup` union and the meaning of the group-coverage assertions
in `tools.test.ts:40` and `:51`.

**That guarantee is recovered at the database instead of dropped.** `platform_tools.group_key`
is a foreign key to `platform_tool_groups(key)` with `ON DELETE RESTRICT`, so a
tool in an undeclared group cannot exist and a group with tools cannot be
deleted. The two coverage tests are rewritten as integrity tests over fetched
data rather than removed.

One guarantee genuinely weakens rather than moving, and it is recorded rather
than glossed. `tools.test.ts:51` forbids a *declared-but-empty* group, because
a heading over nothing reads as a loading failure rather than an absence. A
foreign key cannot express that, so with groups in a table an empty group
becomes possible at runtime for the first time. The render-side belt already
exists — `components/internal-tools.tsx:71` returns `null` for an empty group,
and its comment calls itself a belt to the data tests — so the page stays
correct. What is lost is the compile-time promise that the case cannot arise;
what remains is a renderer that handles it. That is an acceptable trade for
data-driven groups, but it is a trade, not a wash.

### D3. Both consumers cut over together

The home cards and the command palette read one fetched directory. A tool added
through CRUD is findable in the palette the same minute. The plumbing this
requires is the subject of "The trap in this phase" below.

### D4. Read and write ship together; no console editing surface yet

Full CRUD on the API as #318 specifies, exercised by handler and golden tests.
The console reads only. The editing surface is a later, separate change.

The known risk is that write paths with no real caller are wrong in ways tests
do not catch. It is accepted because the API is the deliverable that removes
the deploy, and because a half-built admin form is a worse thing to leave
behind than an unexercised endpoint.

## Schema

One migration, `apps/web/db/migrations/0031_platform_tools.sql` (0030 is the
current head). Migrations here are **manual**: this is applied to production
*before* the PR merges, because Kargo deploys on merge and `db:migrate` does not
ride along.

```
platform_tool_groups
  key          text primary key
  label        text not null
  sort_order   integer not null
  created_at   timestamptz not null default now()
  updated_at   timestamptz not null default now()

platform_tools
  id           uuid primary key default gen_random_uuid()
  name         text not null
  subdomain    text not null unique
  purpose      text not null
  note         text null
  group_key    text not null references platform_tool_groups(key) on delete restrict
  sort_order   integer not null
  created_at   timestamptz not null default now()
  updated_at   timestamptz not null default now()
```

Seeded in the same migration with today's five groups and fifteen tools, in
today's declaration order, so the rendered page is unchanged on the day of
cutover.

Two constraints carry properties that currently live in code:

- **`subdomain`, never a URL.** `toolUrl(tool, baseDomain)` keeps deriving the
  host from configuration, so a non-production console still cannot link
  operators at production tools. A row carrying
  `https://grafana.tesserix.app` would destroy that property permanently and
  invisibly. A `CHECK` constraint restricts `subdomain` to a single DNS label
  (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`), so a stored value cannot smuggle a
  different host into a link.
- **`UNIQUE (subdomain)`** replaces the duplicate-subdomain assertion at
  `tools.test.ts:33`.

## The Go module

`platform-api/internal/modules/tools/`, following `internal/modules/crm/` —
the newer of the two module shapes and the one that already has `RouteTable`.
It imports the kernel and its own internals, and no sibling module;
`internal/architecture` enforces that and test files are not exempt.

Every route names `platform`, taken from `platform.dashboard` in
`packages/console-core/src/routes.ts`. No new capability is invented: one would
assert a Zitadel role nobody holds and fail closed for every operator.

```
GET    /v1/platform/tools               {"tools":  [...]}
POST   /v1/platform/tools               write
PATCH  /v1/platform/tools/{id}          write
DELETE /v1/platform/tools/{id}          write
GET    /v1/platform/tool-groups         {"groups": [...]}
POST   /v1/platform/tool-groups         write
PATCH  /v1/platform/tool-groups/{id}    write
DELETE /v1/platform/tool-groups/{id}    write
```

Per `docs/PLATFORM-API-CONVENTIONS.md`:

- `StandardResponse` envelope, named payload objects, snake_case, `[]` never
  `null`.
- `Idempotency-Key` on every write, via `internal/platform/idempotency` and
  `write.Perform`.
- `httpx.RejectUnknownParameters` on the reads.
- Every route in `RouteTable`, and a matching case in `routeCases()` in
  `capability_test.go`, so a route added without a capability case turns the
  suite red.
- Golden files for success and for each error shape, regenerated with
  `-update-golden` and read as a diff before committing.

**No pagination, deliberately.** This is a fifteen-row directory rendered
whole; a keyset cursor over it would be ceremony, and an unpaginated list that
looks forgotten is worse than one that says why. The module doc states this so
the next reader does not file it as an omission.

`DELETE` on a group that still has tools returns 409 from the foreign key
rather than orphaning rows.

## The console

New `apps/console/lib/tools-directory.ts`, `server-only`, dual path on
`PLATFORM_API_ORIGIN`, following the seam in `lib/crm-queues.ts`. Unset is
byte-for-byte today's behaviour, so unsetting it removes code paths rather
than reverting them — **but the lever is not scoped to this phase.**
`PLATFORM_API_ORIGIN` also switches `fetchTickets`
(`apps/console/lib/platform-api.ts:330`) and the CRM queues, both already cut
over ahead of this one. Unsetting it in production to roll back the tools
directory rolls those back too, at the same time and by the same act — an
estate-wide lever, not a tools-only one.

```
readToolsDirectory(): Promise<{
  groups: ToolGroupRow[]
  tools:  ToolRow[]
  source: "platform-api" | "builtin"
}>
```

Error handling follows the rule written at the top of `crm-queues.ts`:
re-classify at the seam where the refusal has an existing console-vocabulary
equivalent; extend the central classifier only where the condition is new. A
directory that cannot be fetched has an equivalent — the built-in list — so it
is handled at the seam and does not touch either classifier. **If that turns
out to be wrong during implementation, both `lib/db-read-error.ts` and
`components/kit/surface-state.ts` are checked, not one.**

## The trap in this phase

`apps/console/lib/search.ts` builds the palette's tool entries at line 147, and
its importer `components/nav/command-palette.tsx` is `"use client"`. So
`toolEntries` cannot fetch, and `tools-directory.ts` must never be reachable
from it. That is the #299 failure — `pg` in the browser bundle — repeated
exactly.

The plumbing already exists. `app/(console)/layout.tsx:33` is a server
component and already passes `toolsBaseDomain` down through `console-header`
into `command-palette`. The fetched rows travel the same path as a plain
serialisable prop, and `toolEntries` changes signature from
`toolEntries(baseDomain)` to `toolEntries(baseDomain, tools)`.

`npx next build` in `apps/console` before merge. `tsc` resolves modules but
does not bundle them, and that is precisely how this class of break reaches
main.

## Testing

- **Go repository tests against a real Postgres.** These skip silently without
  `TESSERIX_TEST_DB_HOST`. A throwaway container is started and **zero skips**
  confirmed, rather than a pass being reported that was not observed.
- Handler tests, one capability case per route, golden files for success and
  each error shape.
- Console: both branches of the loader, and the labelled-fallback path.
- `tools.test.ts` rewritten from compile-time coverage to data integrity over
  the fetched shape.
- CI lints at `--max-warnings 0`. An unused symbol left behind by the cutover
  fails the build, so the literal's now-unused exports are either kept
  deliberately (the fallback needs `INTERNAL_TOOLS`) or removed.

## Definition of done

1. `0031` applied to production, verified against the live database.
2. `GET /v1/platform/tools` and `/v1/platform/tool-groups` serve the seeded
   directory, refusing a principal without `platform`.
3. Writes work under an `Idempotency-Key`, with golden coverage.
4. The console home page and the command palette both render from the API,
   with `PLATFORM_API_ORIGIN` set.
5. Unsetting `PLATFORM_API_ORIGIN` restores the pre-#318 tools directory
   exactly, AND simultaneously reverts `fetchTickets` and the CRM queues to
   the `apps/web` path — it is an estate-wide lever, not a tools-only one.
6. A fetch failure renders the built-in list, labelled as such.
7. `npx next build` passes; no skipped database tests.

## Deferred to Phase 2, not decided here

- Whether `migrated` should be **derived** from whether a product's IA is in
  console-core, rather than typed into a row. A hand-edited boolean in a
  database drifts exactly as one in source does; it just drifts where nobody
  reviews it.
- Whether Phase 2 — estate *display* fields only, keyed by a `context` the code
  still owns — happens at all.
