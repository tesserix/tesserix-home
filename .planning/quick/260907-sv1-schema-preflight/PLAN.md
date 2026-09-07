---
id: 260907-sv1
slug: schema-preflight
date: 2026-09-07
issue: null
kind: quick
branch: feat/schema-version-preflight
---

# The console refuses to start against a database that is behind it

Migrations here are applied by hand and deploys are not. Kargo ships the console
on merge; `db:migrate` does not ride along. Nothing in CI, ArgoCD or Kargo checks
that the schema a new image needs is actually present, so the only thing standing
between a merge and a broken billing surface is whether someone read the PR
description.

That failed twice within one hour on 2026-09-07, in two different ways:

1. **#610 merged before `0051` was applied.** Production sat at version 50 while
   an image expecting 51 was building. Caught by hand with minutes to spare, only
   because someone thought to look.
2. **The recovery bypassed the runner.** `0051` was applied by piping the file
   through `psql`, so the DDL landed but `schema_migrations` was never written.
   Schema and ledger disagreed, and nothing said so.

Both are the same missing assertion, and the second is the more interesting one:
the schema was *correct* and the system was still in a state no one had declared.

## What already exists — verified, not assumed

- **`schema_migrations(version, name, applied_at)`**, one row per applied
  migration, written by `apps/web/scripts/db-migrate.mjs` inside the same
  transaction as the DDL. Production is at 51. This is the contract, and it is
  what the check reads.
- **CI already runs the runner** (`ci.yml:439`) against a throwaway database, so
  "does this migration apply" is covered. "Has it been applied to PRODUCTION" is
  the gap, and no CI job can close it: GitHub Free has no org secrets and the
  database is in-cluster CNPG, not reachable from Actions.
- **The console's readiness probe is `tcpSocket`.** It passes the moment the port
  opens, so "ready" asserts nothing about correctness today.
- **`maxSurge: 0, maxUnavailable: 1` across 2 replicas.** A container that never
  opens its port halts the rollout with one old replica still serving. That is
  the property this design leans on, and it is why the check exits rather than
  serving a failing health route.
- **`parity-check.mjs` is the precedent for shipping a `pg`-using script**
  (`Dockerfile.console`): esbuild-bundled, `--external:pg` because `pg` IS in the
  standalone output, and copied INSIDE the standalone tree so Node resolves it by
  walking up. The Dockerfile says getting that backwards builds green and fails
  in the cluster. Copy the pattern exactly.

## Decisions, settled — do not re-open these

1. **Exit non-zero; do not add a health route or change the probe.** A failed
   start is the loudest available signal and needs no new HTTP surface. It also
   composes with the existing `tcpSocket` probe rather than replacing it.
2. **The ledger is the source of truth, not the columns.** A check that inspected
   `information_schema` for expected columns would have called failure 2 healthy.
   Comparing versions is what makes "applied" mean "applied by the runner, in a
   transaction, and recorded".
3. **An image AHEAD of the database fails; an image BEHIND it passes.** After a
   migration lands, the currently-running older image must keep serving — that is
   the whole rollout window the migrations are written for. Only "database is
   missing versions this image needs" is an error.
4. **The expected version is baked at BUILD time**, from `apps/web/db/migrations/`,
   into a file copied to the runtime stage. It must not be an env var: a value an
   operator can set is a value an operator can set wrong, and this check exists
   because a human step was skipped.
5. **The preflight must not become a migration runner.** It reports and exits.
   Applying automatically is mark8ly's `migrate` initContainer pattern, is
   probably the right end state, and needs a locking story for 2 replicas — a
   separate decision, deliberately not smuggled in here.

## THE LESSON THIS TASK EXISTS UNDER

The check is trivial. Everything that makes it worth building is in the failure
mode, so the tests that matter are the ones asserting what happens when it fires
— not that it passes when all is well. A preflight that silently passes on a
connection error, a missing file, or an unparseable version is worse than none:
it converts a loud failure into a green one, which is the exact defect it exists
to prevent.

Specifically: a database that cannot be reached is NOT a pass.

## Tasks

- **T1 — the version file.** Emit `schema-version.json` (max version across
  `apps/web/db/migrations/`) during the build. Shared derivation with
  `db-migrate.mjs`'s filename parsing rather than a second regex that can drift.
- **T2 — the preflight.** `scripts/require-schema-version.ts`, bundled as
  `build:preflight` following `build:cron` exactly. Reads the baked version,
  queries `schema_migrations`, names the missing versions on failure, exits 1.
- **T3 — wire it into the image.** `Dockerfile.console`: build the bundle, copy
  both artefacts into the standalone tree, and make the command run the preflight
  before the server — with `exec` on the server so signals still reach Node.
- **T4 — tests.** Behind / equal / ahead; unreachable database; missing or
  malformed version file; and the message naming the missing versions.

## Done means

- [ ] A console image whose migrations exceed the database's ledger refuses to start
- [ ] The message names which versions are missing, and where to run the runner
- [ ] An older image against a newer database still starts
- [ ] An unreachable database fails the preflight rather than passing it
- [ ] Signals reach the Node process — the container still stops cleanly
