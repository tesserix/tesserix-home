---
quick_id: 260831-n6w
slug: no-empty-proposals
date: 2026-08-31
issue: tesserix-home#273 (acceptance criteria 1 and 6 only)
repo: tesserix/secret-service
status: complete
branch: fix/no-empty-proposals
commit: 9497e69c2edf4ffd0fd2785ca4f89cb629304453
---

# No proposal opens a pull request with an empty diff, and the review list paginates

Both criteria are done in one commit on `fix/no-empty-proposals` in
`/Users/Mahesh.Sangawar/personal/tesserix-new/secret-service`:

`fix(gitops): refuse to open a pull request with no diff, and paginate the review list (tesserix-home#273)`

Nothing was merged, pushed, or applied to any cluster. No cluster, database or
GitHub API was queried.

## Criterion 1 — the empty-diff pull request

`ProposeAll` now refuses a proposal in which neither file changes, returning the
new sentinel `gitops.ErrNoChange` before any branch exists.

The AppProject computation moved out of `commitProject` and above
`createBranch`, as the plan required: `updated == values` alone cannot decide a
no-op, because the AppProject moves in step with the whitelist and can need a
change when the whitelist does not. The new shape is:

- `planProject(ctx, changes, values) (projectUpdate, error)` — reads the
  AppProject and works out what it would become, writing nothing. Returns the
  zero `projectUpdate` when `ProjectPath` is unset.
- `projectUpdate.changed()` — the one place that answers "does this half move?".
- `ProposeAll` refuses when `updated == values && !project.changed()`.
- `commitProject(ctx, branch, title, projectUpdate)` keeps its own guard, now
  expressed as `if !project.changed()`. It is kept as well as, not instead of,
  the refusal; the comment says so.

The refusal's comment states the tesserix-k8s#392 fact — that these proposals
generate the title shape of a deliberate negative control which must never be
merged, so the console was manufacturing mergeable near-identical neighbours to
it — so a future reader deleting the guard as redundant has to meet it.

One thing the plan did not specify: when the whitelist is unchanged and only the
AppProject moves, `values.yaml` is no longer committed either. Committing it
would only widen the diff under review with a no-op file. This is guarded and
tested.

### `ErrNoChange` is never a 502

- `handlers/whitelist.go` `submit` now answers `200 {"namespace":…,"app":…,
  "status":"unchanged"}` with **no** `pullRequest` key. Real errors still 502.
- `handlers/access.go` `CreateGrant` sets `"proposal":"unchanged"` instead of
  `proposalError`. Tracing the caller was the point here: `propose` returns
  `url, err` straight to `CreateGrant`, which had been turning any error into
  `proposalError`, and the console renders that as "Granted, but not recorded in
  Git" — a false statement when the whitelist already records the grant.
- The audit event is still recorded for both, with `outcome: allowed` and
  `reason: "already in place; no pull request was opened"`, which distinguishes
  it from a proposal that actually opened one (no reason) and from a failure
  (`outcome: error`).

## Criterion 6 — the review list truncates at 100

`Pulls` now walks pages until a short page returns, bounded by `maxPullPages`
(10 pages × `pullPageSize` 100 = 1000 open pull requests). Hitting the bound
returns an error naming the bound and returns `nil` rather than a short list —
returning what had been collected would reproduce the failure being fixed: a
truncated list that reads as complete.

Paging by `page=N` was chosen over following `Link: rel="next"` because
`GitHub.do` does not surface response headers and plumbing them through for this
one call would touch every other request. The plan permits either.

The two sibling calls in `Pull` (`/files`, `/reviews`) are unchanged, with a
comment recording that leaving them unpaginated is deliberate.

## Files changed

### `/Users/Mahesh.Sangawar/personal/tesserix-new/secret-service` (branch `fix/no-empty-proposals`, commit `9497e69`)

| File | Change |
|------|--------|
| `apps/api/internal/gitops/github.go` | `ErrNoChange`; `projectUpdate` + `planProject` hoisted above `createBranch`; the no-op refusal; `commitProject` takes the precomputed update and keeps its guard; the whitelist is not committed when unchanged |
| `apps/api/internal/gitops/github_test.go` | `counts` recorder helper; four new tests; `call` now records the query string |
| `apps/api/internal/gitops/review.go` | `Pulls` paginates with a bound and reports truncation; note on the unpaginated sibling calls |
| `apps/api/internal/gitops/review_test.go` | three pagination tests plus helpers |
| `apps/api/internal/api/handlers/whitelist.go` | `submit` answers `ErrNoChange` as 200/`unchanged`; shared `recordEvent` with the no-op audit shape |
| `apps/api/internal/api/handlers/whitelist_test.go` | `serveAudited` helper; three new tests |
| `apps/api/internal/api/handlers/access.go` | `CreateGrant` distinguishes `ErrNoChange`; `record` delegates to `recordEvent` |
| `apps/api/internal/api/handlers/access_test.go` | one new test |
| `apps/web/lib/api.ts` | `Proposal.pullRequest` is optional |
| `apps/web/components/namespace-inspector.tsx` | a withdrawal that opened no pull request no longer renders an empty link |
| `apps/web/components/secret-inspector.tsx` | `?? null` for the now-optional field |

### `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home`

`PLAN.md` and this `SUMMARY.md` under `.planning/quick/260831-n6w-no-empty-proposals/`,
committed separately. No code in this repo was touched.

## Tests added

gitops:

- `TestProposeRefusesAnAppThatIsAlreadyWhitelisted` — `ErrNoChange`, empty URL,
  and 0 branches / 0 commits / 0 pull requests against the recorder
- `TestProposeRefusesRemovingAnAppThatWasNeverWhitelisted` — same, for revoke
- `TestProposeOpensAPullRequestWhenOnlyTheAppProjectChanges` — whitelist
  unchanged, project changed → PR opened, `values.yaml` not committed
- `TestProposeCommitsBothFilesOnOneBranchInOnePullRequest` — 1 branch, 2
  commits, 1 PR, same branch for both files
- `TestPullsAsksOnceWhenTheFirstPageIsShort`
- `TestPullsWalksEveryPageRatherThanTruncatingAtAHundred` — 100 + 7 across two
  pages, requests page 1 then page 2 and stops
- `TestPullsReportsTheBoundRatherThanReturningAShortList` — error, `nil` list,
  bounded request count

(The plan's "whitelist changed but AppProject unchanged" case was already
covered by `TestProposeLeavesTheAppProjectAloneWhenTheNamespaceIsAlreadyListed`;
it still passes.)

handlers:

- `TestProposeAnswersANoOpAsSuccessRatherThanABadGateway` — 200, no
  `pullRequest`, `status: unchanged`
- `TestWithdrawAnswersANoOpAsSuccess`
- `TestTheAuditTrailSeparatesAProposalFromANoOp` — the three outcomes are
  distinguishable and a no-op is not filed as an error
- `TestGrantDoesNotReportAnAlreadyRecordedWhitelistAsAFailure`

## Verification — actual output

`go test ./...` from `apps/api/` (exit 0):

```
?   	github.com/tesserix/secret-service/api/cmd/server	[no test files]
?   	github.com/tesserix/secret-service/api/internal/api	[no test files]
ok  	github.com/tesserix/secret-service/api/internal/api/handlers	2.474s
ok  	github.com/tesserix/secret-service/api/internal/api/middleware	0.449s
ok  	github.com/tesserix/secret-service/api/internal/audit	0.625s
ok  	github.com/tesserix/secret-service/api/internal/auth	1.153s
ok  	github.com/tesserix/secret-service/api/internal/bao	1.429s
ok  	github.com/tesserix/secret-service/api/internal/config	1.786s
ok  	github.com/tesserix/secret-service/api/internal/gcpsm	2.063s
ok  	github.com/tesserix/secret-service/api/internal/gitops	2.395s
ok  	github.com/tesserix/secret-service/api/internal/k8s	0.553s
ok  	github.com/tesserix/secret-service/api/internal/secrets	0.897s
```

`go test -count=1 -v ./internal/gitops/ ./internal/api/handlers/` (exit 0) —
88 test results, `grep -c '^--- FAIL'` = 0:

```
ok  	github.com/tesserix/secret-service/api/internal/gitops	0.753s
ok  	github.com/tesserix/secret-service/api/internal/api/handlers	0.676s
```

`go vet ./...` from `apps/api/` — exit 0, no output.

`pnpm lint` from the repo root — exit 0:

```
> @tesserix/secret-service-web@0.0.1 lint /Users/…/secret-service/apps/web
> eslint .
```

`pnpm typecheck` from the repo root — exit 0:

```
> @tesserix/secret-service-web@0.0.1 typecheck /Users/…/secret-service/apps/web
> tsc --noEmit
```

Both pnpm scripts print `WARN Unsupported engine: wanted: {"node":">=24.0.0"}
(current: {"node":"v22.19.0"})`. Pre-existing, and both scripts exit 0 anyway.

Test output was written to files and grepped; nothing was piped through
`tail -N` or `head -N`.

## Deviations and judgement calls

1. **Three files in `apps/web` were touched.** Making `ErrNoChange` answer 200
   without a `pullRequest` broke the console: `namespace-inspector.tsx` mapped
   withdrawal results straight to `p.pullRequest` and would have rendered an
   empty anchor with `key={undefined}`, and `tsc --noEmit` failed on the
   now-optional field until `secret-inspector.tsx` was given `?? null`. This is
   the minimum needed to keep the console correct and typechecking — not
   criterion 2's UI redesign. No new UI copy was added: a no-op withdrawal
   simply shows no link.

2. **`values.yaml` is no longer committed when it is unchanged.** Not in the
   plan, but the plan's own test list requires the project-only case to open a
   PR, and committing an unchanged whitelist onto that branch would put a no-op
   file in the diff — the same defect at a smaller scale.

3. **`Whitelist.record` and `Access.record` were collapsed onto one shared
   `recordEvent`.** They were byte-identical apart from the receiver, and the
   `ErrNoChange` audit shape has to be the same on both routes or the trail
   drifts. Both methods remain as one-line wrappers, so no call site changed.

4. **The truncation error returns `nil`, not a partial list.** Stated above; the
   alternative reads as complete, which is the bug.

5. **Paging by `page=N` rather than `Link: rel="next"`** — `do` does not expose
   response headers. The plan allowed either.

6. **Prettier reports the three `apps/web` files as unformatted, and reported
   them that way before this change too** (verified by stashing the work and
   re-running `prettier --check` on the pristine files). `pnpm lint` and
   `pnpm typecheck` are the repo's gates and both pass; running
   `prettier --write` would have added unrelated reformatting churn to the diff,
   so it was not run.

7. **`pnpm install --frozen-lockfile` was required** — the repo had no
   `node_modules`. Install succeeded; no lockfile change.

8. Nothing from the out-of-scope list (criteria 2–5, the `Rewirer` type
   assertion, the free-text chart path) was touched.
