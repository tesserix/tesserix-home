# Parity run diagnostics (tesserix-home#580)

A failed parity run shows a red badge and a timestamp and nothing else. The
failure reason is sanitized, truncated and stored — and never selected. The
manual re-run route that two module headers promise has no caller, so the only
recourse is to wait for the nightly CronJob.

That matters because this check gates #327's observation window and the Stripe
write-key revocation: a week of red with no visible cause is a week of a
go-live gate blocked by something nobody can name.

## Verified before planning (2026-09-06, `origin/main` @ bf517b8)

- `error` IS stored: `lib/billing/parity-run.ts` sanitizes and truncates to
  `MAX_ERROR_LENGTH`, and `ParityRun.error` is non-null exactly on `failed`
  per 0033's CHECK.
- `error` is NOT selected: `readLatestRuns`' SELECT lists
  `mode, source, outcome, ran_at, difference_count, differences`.
  `LatestParityRun` has no `error` field, so `LatestRunSummary` could not
  render one even if it wanted to.
- The re-run route has no caller: `grep -rn "parity-check" --include='*.tsx'`
  returns zero hits.
- **No client component in the console fetches an API route.** Every mutation
  is a server action (`useTransition`, `auditedOperation`, `revalidatePath`).
  The route also writes no audit row.
- `promotePublication` IS wired — `actions.ts:658`, on a `succeeded` outcome.
  The two comments calling it deferred are wrong.
- The CronJob IS deployed and running: `console-parity-check` in namespace
  `tesserix`, `15 2 * * *` Etc/UTC, 9d old, last run Complete 18h ago,
  `parityCheck.enabled: true` in `values-prod.yaml`. The route comment saying
  "until it lands, nothing runs the check on a schedule and the window has not
  started" is not merely stale — it tells an operator the go-live window is not
  accruing when it is.

## Tasks

### T1 — Carry the stored error through to the operator

`readLatestRuns` selects `error`; `LatestParityRun` gains `error: string | null`;
`LatestRunSummary` renders it on a `failed` run.

Done when: a `failed` row's stored reason is visible on the catalog surface,
and a non-`failed` row renders exactly as it does today. Covered by a repo
integration test (the column round-trips) and a `catalog-views` render test
(shown on `failed`, absent otherwise).

### T2 — One definition of "run every pair", two callers

The route's nested `STRIPE_MODES x CATALOG_SOURCES` loop moves into
`lib/billing/parity-run.ts` as an exported function returning the per-pair
results plus the two flags the route turns into status codes. The route calls
it and keeps its exact response contract; nothing about its status codes,
body shape or auth changes.

This is the same argument that module header already makes for
`performParityCheck` — there must be one definition of the run, or the two
callers drift and #327's window becomes a mixture of both.

Done when: `route.test.ts` passes unchanged.

### T3 — An audited re-run control the operator can actually press

A `rerunParityCheckAction` server action in `catalog/actions.ts`, calling T2's
function, guarded by `billing` the way the route is, wrapped in
`auditedOperation` like every other write on this surface, and
`revalidatePath`-ing the catalog. A button in `ObservationStrip`'s header
invokes it through `useTransition`.

Deliberately a server action and not a `fetch` to the route: a client fetch
would be the console's only one, and would skip the audit trail every other
mutation on this surface writes.

Done when: pressing the control records rows, refreshes the surface, writes an
audit row, and refuses without the `billing` capability.

### T4 — Correct the three misleading comments

1. `lib/billing/publish-executor.ts` — "Promotion … is Task 7's, correctly
   deferred". It is wired at `actions.ts:658`.
2. `lib/db/publish-repo.ts` — `promotePublication`'s "its caller — not yet
   wired; a later task". Same.
3. `app/api/internal/parity-check/route.ts` — "Not in this PR: the Kubernetes
   CronJob … Until it lands, nothing runs the check on a schedule and the
   window has not started." It landed and it is running.

Each is replaced with what is true and where, not deleted: the reason the
comment existed (promotion is separate from publishing; the CronJob is why the
route is not the scheduler) is still worth stating.

Done when: no comment in the parity/publish surface describes shipped work as
pending.

## Out of scope

- #579 (the check has no alerting) — this issue is about the surface an
  operator already has open.
- #540 (test-mode publishing) — orthogonal.
