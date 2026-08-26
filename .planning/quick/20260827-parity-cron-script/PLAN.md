---
slug: parity-cron-script
date: 2026-08-27
mode: quick
issue: 326
---

# The parity check's scheduled runner

Third PR for #326 P1a, stacked on #372 (`feat/plan-catalog-parity-check`).

## Why a script and not an HTTP call

#372's route is guarded by the console's operator-session convention
(`middleware.ts:53` returns 401 to anything without a session). A Kubernetes
CronJob has no operator and cannot mint one, so **the scheduler cannot call the
route**. The alternatives were a shared-secret header (a second auth scheme in
the console, and a route reachable without an operator — bad neighbours for the
P2 argument that revokes mark8ly's Stripe write key) or a Zitadel service
account (largest, and nothing in this repo does it today).

Decided: **the CronJob runs a script that does the work directly** — same
comparator, same repo functions, no HTTP surface, no new credential path. The
route stays as the operator-triggered "run it now" that P1b's surface will use.

## The packaging problem, which is the actual work

`Dockerfile.console` ships **only** Next's standalone output
(`COPY --from=builder … /.next/standalone ./`, `CMD ["node",
"apps/console/server.js"]`). Arbitrary TypeScript under `apps/console/` is not
in the image, so the CronJob cannot simply `node` a source file.

`esbuild` is already a dependency at the repo root. So:

1. `apps/console/scripts/parity-check.ts` — the entry point. Imports
   `compareCatalogToStripe`, `readCatalogAmounts`, `recordParityRun` and
   `stripePriceReader` from the same modules #372 added. **It must not
   reimplement any of them** — a second copy of the comparator is the exact
   duplication #326 exists to remove.
2. A build step bundling it to a single plain-JS file with esbuild
   (`--platform=node --format=esm --bundle`), wired as a `build:cron` script in
   `apps/console/package.json` and run in the Dockerfile's builder stage.
   Keep `pg` and `stripe` external so the bundle stays small and the installed
   SDKs are used — they are present in the runtime stage's node_modules.
3. `Dockerfile.console` — COPY the bundle into the runtime stage. **Do not
   change `CMD`**; the image's default job is still the web server. The CronJob
   overrides `command` to run the bundle.

## Behaviour

- Reads the catalog, calls `listPrices()`, runs the comparator, writes exactly
  one `plan_catalog_parity_runs` row. Same three outcomes as the route.
- **Every failure path writes a `failed` row** — missing key, Stripe
  unreachable, database unreachable-after-connect. A run that dies silently
  leaves a gap in the 7-day window indistinguishable from a clean day, which is
  the worst failure this design can have.
- If the database itself is unreachable there is nowhere to write; exit
  non-zero with a clear message so the CronJob's own failure is the signal.
- Exit code: `0` for `clean` AND for `differences` — differences are the
  check's *output*, not a crash, and a non-zero exit would make Kubernetes
  retry and write duplicate rows. Non-zero only for `failed`.
- Log one structured line with the outcome and difference count.

## Tests

`apps/console/scripts/parity-check.test.ts`, mocking the four imported modules:

- clean comparison → one `clean` row, exit 0
- differences → one `differences` row with the full report, exit 0 (assert the
  exit code explicitly — this is the case a naive implementation gets wrong)
- missing Stripe key → one `failed` row carrying the reason, non-zero exit
- Stripe throwing → one `failed` row, non-zero exit
- exactly one row written in every case — never zero, never two

Plus a guard test asserting the script imports the comparator rather than
defining its own: assert `compareCatalogToStripe` is the mocked module's
function and was called.

## Verification

- Rebuild `console-core` first. `pnpm test`, `typecheck`, `lint`.
- `next build` must still pass.
- **Actually run the esbuild bundle step and `node --check` the output**, then
  confirm the bundle does not inline `pg` or `stripe`. A bundling step nobody
  executes is a Dockerfile line that fails in CI.

## NOT in this PR

- The CronJob manifest itself — it lives in `tesserix-k8s`, a different repo.
  The PR body must say so, and say what the manifest needs: the console image,
  a `command` override pointing at the bundle, the database env the console
  already uses, and the Stripe restricted key from Secret Manager.
- Any console surface (P1b). Any Stripe write. Any mark8ly change.
