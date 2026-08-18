# Console

The Tesserix platform console — the operator surface at `console.tesserix.app`.

## Running it locally

**This is the standard way to run the console.** Three commands:

```bash
npm install                      # from the repo root
cd apps/console
npm run dev:db:reset             # start Postgres, migrate, seed
npm run dev:all                  # the admin stub + the console together
```

Then open <http://localhost:3003>.

`dev:all` runs two processes because the console needs both: a database it
reads directly, and a stand-in for `apps/web`'s admin API. Running `npm run dev`
alone gives you a console whose CRM surfaces error and whose dashboard, tickets,
support-analytics and audit-log surfaces have no upstream.

### Why this exists

Before [#271](https://github.com/tesserix/tesserix-home/issues/271), there was
no local path to a rendered page with real data:

- Playwright ran with `TESSERIX_DB_*` unset, so **every CRM surface rendered its
  error state by design**. The suite passed 17/17 and proved only that the
  console fails gracefully.
- [#245](https://github.com/tesserix/tesserix-home/issues/245), a live
  drift-clock bug in production, had to be proved with pglite integration tests
  because e2e could not reach the behaviour.
- [#243](https://github.com/tesserix/tesserix-home/issues/243) was filed because
  no e2e opened a detail page.

The fastest feedback loop available was unit tests. Now `npm run dev:all`
renders every surface with data, and the e2e suite asserts what pages **show**
rather than that they fail politely.

### The commands

| | |
|---|---|
| `npm run dev:db:up` | Start the dev Postgres (`docker-compose.dev.yml`) |
| `npm run dev:db:migrate` | Apply `apps/web/db/migrations/` — the real ones |
| `npm run dev:db:seed` | Representative CRM data |
| `npm run dev:db:reset` | All three, in order |
| `npm run dev:stub` | The admin-API stub alone, on `:3002` |
| `npm run dev` | The console alone, on `:3003` |
| `npm run dev:all` | Stub and console together |

Configuration lives in `.env.development`, which is **committed on purpose** —
every value points at the throwaway database or the local stub. Real
credentials belong in `.env.local`, which is gitignored.

The dev database uses **trust auth**, so it has no password at all; the
`TESSERIX_DB_PASSWORD` in that file exists only because the console's
`isDatabaseConfigured()` and `db-migrate` both require a value. CI's service
container is configured identically, so local and CI behave the same.

### The database runs on port 55432

Not 5432, so it cannot collide with — or silently connect to — a Postgres
already running on your machine.

### The seed

`scripts/seed-dev.mjs` contains **no schema**. It only INSERTs; every table and
column comes from the migrations, so a migration that adds a NOT NULL column
makes the seed fail loudly rather than quietly writing a shape the application
no longer expects.

It is deterministic — a fixed PRNG and one reference instant — so two runs
produce identical data and an e2e test can assert on a named organisation
rather than "whatever is in row 1".

What it produces, and why each part is there:

| | |
|---|---|
| **140 organisations** | Past the 100-row page size, so the pagination from #240/#241 is exercisable locally |
| **All five stages** | `new`, `contacted`, `qualified`, `won`, `lost` — a queue filtered to a stage with no rows looks broken |
| **~30 due, ~37 never contacted** | Both queue bands, including Ruling 8's case: the clock starts at creation when `last_contacted_at` is null |
| **Contacts with and without follower counts** | #242 made both filters admit what they do not know; a seed where every row has a value cannot exercise that |
| **Countries, some null** | The `UNKNOWN_COUNTRY` filter needs something to match |
| **Two suppressions** | One by email, one by handle — both unique indexes and both lookup paths |
| **A few multi-product organisations** | The shape the schema exists for: one business prospected for two products independently |

### The admin-API stub

`dev/admin-stub.mjs` serves the eight endpoints the console reads from
`apps/web`, selected by `WEB_INTERNAL_ORIGIN`.

**It is scaffolding with a known end.** #271 puts it in M13 because it *shrinks*
as the platform API replaces those endpoints — by the end of M13 most of it is
unnecessary. It should not grow features the real endpoints lack.

It reproduces what production actually returns, including the awkward parts:
the dashboard's four-domains-in-one-object payload, a populated `failures` array
on a `200` audit response, and a **404 from `conversion-status`** — that
endpoint exists for no product, and #246 records that every Handoff signal
therefore reads `unknown`. A stub that invented a `200` would make a broken
feature look healthy. Set `ADMIN_STUB_CONVERSION=200` to develop the other
branch.

**The stub is verified by the console's own parsers.** `dev/admin-stub.test.ts`
runs `parseDashboard`, `parseTickets`, `parseTicketDetail`,
`parseSupportAnalytics` and `parseEstateAuditLog` over real stub responses, so
a stub that drifts from the contract is a failing test rather than a silently
wrong local environment.

That test is also the **equivalence harness** for the platform API migration:
when a Go module replaces one of these endpoints, the same parsers must accept
its responses.

## Tests

```bash
npm run test:unit    # vitest — lib/, app/, components/, dev/
npm run e2e          # Playwright; starts the stub and the console itself
```

E2E needs the database seeded first (`npm run dev:db:reset`). CI does this with
a Postgres service container, the same migrations and the same seed.

## Auth

`NEXT_PUBLIC_DEV_AUTH_BYPASS=true` skips the Zitadel round trip locally. The
middleware **throws at startup** under `NODE_ENV=production`, so it cannot leak
into a deployment — which is what makes it safe to commit in
`.env.development`.
