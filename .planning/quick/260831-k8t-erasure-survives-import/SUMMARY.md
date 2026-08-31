---
quick_id: 260831-k8t
slug: erasure-survives-import
date: 2026-08-31
issue: tesserix-home#226
status: complete
branch: fix/226-erasure-survives-import
migration: apps/web/db/migrations/0041_crm_erased_identifiers.sql
migration_applied: false
new_env_var: CRM_ERASURE_HASH_KEY
---

# An erased contact is no longer re-created by the next import

`eraseContact` records a keyed HMAC of each identifier it destroys into a new
`crm_erased_identifiers` table; `previewImport` and `commitImport` hash every
incoming row and refuse any that matches, counting it as `skippedErased` —
separate from `skippedSuppressed`, with its own note on the import card.

## Before merging

**Apply `0041_crm_erased_identifiers.sql` to production first.** Migrations are
manual here and Kargo deploys on merge, so the code would otherwise be live
before the table exists — and this is on the import path, not a cold corner:
every `previewImport`/`commitImport` would fail on a missing relation.

**Provision `CRM_ERASURE_HASH_KEY` in the same window.** It is a new
environment variable with no default. Without it:

- `eraseContact` throws and the erasure is refused (fail-closed, deliberate)
- imports still run normally while `crm_erased_identifiers` is empty
- imports are refused outright the moment the register is non-empty

Local development gets a committed non-secret value in
`apps/console/.env.development`; production needs a real secret in GCP Secret
Manager mapped through the console's ExternalSecret. Rotating it later
invalidates every hash already recorded, so it is not a routine rotation.

## Files changed

New:

- `apps/web/db/migrations/0041_crm_erased_identifiers.sql` — the register
- `apps/console/lib/db/crm-erasure-hash.ts` — `server-only`; HMAC-SHA256
- `apps/console/lib/db/crm-identity.ts` — the two normalisers, extracted
- `apps/console/lib/db/crm-erasure-hash.test.ts` (9 tests)
- `apps/console/lib/db/crm-erasure-import.integration.test.ts` (15 tests)

Modified:

- `apps/console/lib/db/crm-erasure.ts` — records the hashes in `eraseContact`'s
  existing transaction, from the `old` CTE's pre-image
- `apps/console/lib/db/crm-repo.ts` — `isErased`, `erasureCheckGuard`,
  `ErasureCheckUnavailableError`, `skippedErased` on both import paths,
  normalisers re-exported from `crm-identity.ts`
- `apps/console/app/(console)/platform/crm/import/counts.ts`,
  `import-view.tsx`, `actions.ts` — the count, its copy, the audit key
- `apps/console/app/(console)/platform/crm/[organisation]/actions.ts` — maps
  the missing-key refusal to a message that says the contact was NOT erased
- `apps/console/.env.development` — local key
- five existing test files: fixtures gained `skippedErased`, two pglite suites
  gained migration 0041, the erasure suite stubs the key

## Design notes worth keeping

**Erasure is checked before suppression, in both paths.** Someone can be on
both lists and the order decides which remedy the operator is shown. The
suppressed copy says "remove the suppression" — wrong, and actionable, for
someone who asked to be forgotten. Pinned by a test.

**The normalisation is imported, not reimplemented.** `normalizeContactEmail`
and `normalizeInstagramHandle` moved to `crm-identity.ts` so
`crm-erasure-hash.ts` can use the exact functions `findMatchingOrganisationId`
matches with, without `crm-repo` and `crm-erasure-hash` importing each other.
`crm-repo.ts` re-exports `normalizeInstagramHandle` so `crm-writes.ts` is
unchanged. The agreement is asserted against the real functions — a hardcoded
digest would keep passing if a normaliser changed underneath it, and every
failure mode here is silent.

**No key + non-empty register refuses the import.** The plan's
self-consistency argument (no key -> erasure throws -> register empty ->
nothing to check) holds only while the key has never been set. If it is later
unset or lost, the register is non-empty and an unguarded import would
re-create erased people while reporting `skippedErased: 0`.
`erasureCheckGuard` probes once per batch, lazily, and only on the no-key
branch.

## Verification

`pnpm test` — full monorepo, uncached (`--force`):

```
@tesserix/homechef-shared:test:unit:  Test Files  1 passed (1)
@tesserix/homechef-shared:test:unit:       Tests  9 passed (9)
@tesserix/platform-auth:test:unit:  Test Files  7 passed (7)
@tesserix/platform-auth:test:unit:       Tests  120 passed (120)
@tesserix/console-core:test:unit:  Test Files  6 passed (6)
@tesserix/console-core:test:unit:       Tests  87 passed (87)
web:test:unit:  Test Files  23 passed (23)
web:test:unit:       Tests  261 passed (261)
console:test:unit:  Test Files  177 passed (177)
console:test:unit:       Tests  2957 passed (2957)

 Tasks:    8 successful, 8 total
```

Baseline before any change was 175 files / 2930 tests in `console`; this adds
2 files and 27 tests.

`pnpm --filter console build`:

```
> console@0.1.0 build
> next build

▲ Next.js 16.2.11 (Turbopack)

⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
  Creating an optimized production build ...
✓ Compiled successfully in 17.9s
  Running TypeScript ...
  Finished TypeScript in 10.0s ...
  Collecting page data using 13 workers ...
✓ Generating static pages using 13 workers (7/7) in 82ms
  Finalizing page optimization ...
```

Exit 0. The middleware deprecation warning is pre-existing and unrelated.
`pnpm --filter console exec eslint --max-warnings 0` is clean.

### One unexplained failure, not reproduced

The first full `pnpm test` run after the audit-summary fixture edit reported
`1 failed | 2956 passed`; its output was truncated before the failing test's
name was captured. Eight subsequent full runs (five `vitest run` on `console`,
two `pnpm test --force`, one cached) were green at 2957/2957. Recorded rather
than written off — a failing-then-passing test is unexplained, not unrelated.
If it recurs it should be chased, not re-run.

## Deviations from the plan

1. **The normalisers were extracted to a new module** rather than imported
   from `crm-repo.ts` directly, which would have created an import cycle
   between `crm-repo` and `crm-erasure-hash`. Still one definition, imported
   by both — the constraint the plan cared about.
2. **Added `ErasureCheckUnavailableError`**, not in the plan. Without it the
   "the two halves cannot disagree" argument silently stops holding if the key
   is ever unset after an erasure has been recorded — the exact silent no-op
   the feature exists to prevent.
3. **Added operator-facing error messages** in three actions
   (`previewImportAction`, `commitImportAction`, `eraseContactAction`). The
   default "That change was not saved" reads as transient for what is a
   deployment fault, and for the erasure it would let an operator believe a
   DPDP request was honoured when it was refused.
4. **Added `CRM_ERASURE_HASH_KEY` to `apps/console/.env.development`** with a
   clearly-labelled non-secret value, so local "forget me" is not permanently
   broken. That file is committed on purpose and carries only dev values.
5. **Added `erased` to the `crm.import` audit summary.** A count folded into
   another count evidences nothing.

Not done, as instructed: no backfill, no migration applied anywhere, no
cluster or database queried, `eraseContact`'s nulling behaviour and the partial
unique index untouched, suppression list and its copy untouched.
