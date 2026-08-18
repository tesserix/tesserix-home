---
status: complete
date: 2026-08-18
issue: 271
---

# Local development: seed + admin stub (#271)

## The bug found by actually running it

The seed and the stub were both working, and **every CRM surface still rendered
"Could not load organisations"**:

```
[console] failed to read organisations from tesserix-postgres
Error: The server does not support SSL connections
```

`apps/console/lib/db/tesserix.ts` hard-codes `ssl: { rejectUnauthorized: false }`
because CNPG self-signs. A plain local Postgres speaks no TLS and *refuses* the
negotiation — so no amount of seeding would have made a single surface render.
The same gap existed in `apps/web/scripts/db-migrate.mjs`.

Both now honour `TESSERIX_DB_SSLMODE=disable`, opt-out only: any other value,
including the charts' `require` and anything mistyped, leaves TLS on. The
decision is extracted as `sslOption()` and pinned by a test, because a default
that silently downgrades a deployed connection to plaintext is not something to
leave as a comment.

Writing the seed without running the console would have shipped a
non-functioning feature that looked complete.

## Delivered

- **`docker-compose.dev.yml`** — Postgres on 55432, so it cannot collide with a
  developer's own.
- **`scripts/seed-dev.mjs`** — 140 organisations, deterministic. Contains **no
  schema**: INSERT-only, so the migrations stay the single source of truth.
- **`dev/admin-stub.mjs`** — the eight admin endpoints on 3002.
- **`dev/admin-stub.test.ts`** — 19 tests running the console's OWN parsers over
  the stub's responses. Drift becomes a failing test, and this doubles as the
  equivalence harness for the platform API migration.
- **`e2e/seeded.spec.ts`** — 8 tests asserting what surfaces SHOW.
- CI gains a Postgres service container, the real migrations and the same seed.
- `apps/console/README.md`.

## Verified by running, not asserting

Every CRM surface, the ticket queue, ticket detail and audit log render real
data. Full suite: 1313 unit tests, 25 e2e (17 pre-existing + 8 new), lint and
typecheck clean, `pnpm install --frozen-lockfile` passes.

## Assertions I got wrong, and what they taught

Three e2e tests failed on first run — the app was right, my assertions were not:

- `getByText("Amber Collective 1")` also matches **"Amber Collective 127"**. The
  seed numbers rows, so short names are prefixes of longer ones. Needs `exact`.
- Contacts are behind a **tab**; the detail page opens on Activity. The test now
  clicks through, which is better coverage than the original assertion.
- The ticket queue **does not render ticket numbers** at all. Asserting on
  `MK-1041` failed against a perfectly correct page.

## Deliberately honest fixtures

`conversion-status` returns **404**, matching production — the endpoint exists
for no product (#246). A stub inventing a 200 would make a broken feature look
healthy locally, the opposite of what #271 is for. `ADMIN_STUB_CONVERSION=200`
serves the other branch. The audit stub returns a populated `failures` array on
a 200, so the partial-failure path is renderable.

## Not done

The stub does not authenticate. The real endpoints authorise by replaying the
operator's cookie, but the dev-auth bypass means there is no cookie to replay,
and reproducing the login flow would not exercise the surface under test.
