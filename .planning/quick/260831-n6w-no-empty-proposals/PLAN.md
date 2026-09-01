---
quick_id: 260831-n6w
slug: no-empty-proposals
date: 2026-08-31
issue: tesserix-home#273 (acceptance criteria 1 and 6 only)
repo: tesserix/secret-service
---

# No proposal opens a pull request with an empty diff, and the review list paginates

Scope agreed with the repo owner: **criteria 1 and 6 only**. Criteria 2, 3, 4
and 5 are design decisions or a UI redesign and are deliberately NOT in this
change. Do not attempt them; do not "tidy" toward them.

All work is in `/Users/Mahesh.Sangawar/personal/tesserix-new/secret-service`.

## Criterion 1 — the empty-diff pull request

`apps/api/internal/gitops/github.go:90` `ProposeAll` computes `updated` from
`values` and **never compares them**. `AddApp` is idempotent and returns the
input unchanged when the app is already whitelisted, so re-proposing an existing
entry creates a branch, commits an unchanged file, and opens a pull request with
no diff. `RemoveApp` has the same shape, producing an empty `revoke` PR, which
reads worse.

**The guard already exists in the sibling function, with the reason written
down**, and is tested (`github_test.go:332`):

```go
// github.go:174, inside commitProject
// An unchanged file still commits, and the review would open on an empty diff.
if updated == project { return nil }
```

### Why this is a safety issue, not untidiness

The generated title shape is identical to **tesserix-k8s#392**, a deliberate
negative control that **must never be merged** — merging it would create the
policy whose absence produces the 403 that proves the grant is bounded. So the
console manufactures mergeable, near-identical neighbours to a pull request that
must not be merged. Say this in the code comment; a future reader deleting the
guard as redundant needs to meet that fact.

### The part the issue does not mention

`updated == values` alone is NOT sufficient. `commitProject` moves the AppProject
destinations in step with the whitelist, and the project may need a change even
when the whitelist does not. Skipping the pull request requires knowing **both**
are no-ops — and `commitProject` currently reads the project *inside* itself,
after the branch already exists.

So: hoist the project computation above `createBranch`, decide from both
results, and only then create the branch. Keep `commitProject`'s own guard —
it is still correct and still tested, and defence in depth here costs nothing.

### What a no-op should return

**A sentinel error, `ErrNoChange`**, not an empty URL with a nil error. An empty
string that callers must remember to check is the shape that produced this bug
in the first place.

Callers must then distinguish it, and **a no-op is not a bad gateway**:

- `apps/api/internal/api/handlers/whitelist.go:149` currently maps any error to
  `502` with `err.Error()` in the body. `ErrNoChange` must not become a 502:
  the desired state already holds, which is a success from the operator's point
  of view. Answer 200 with a body that says nothing needed changing and carries
  no pull-request URL.
- `apps/api/internal/api/handlers/access.go:101` returns `url, err` straight to
  its caller and records an audit event. Trace what its caller does with the
  error and give `ErrNoChange` the same treatment — a grant whose whitelist
  entry already exists is not a failed grant.
- The audit event must still be recorded, and must be distinguishable from a
  proposal that actually opened a PR. A trail that cannot tell "proposed" from
  "already in place" evidences nothing.

`Propose` (single change) delegates to `ProposeAll` and inherits the fix.

### Tests

`whitelist_test.go` has no no-op case — which is how an idempotent `AddApp` and
a non-idempotent `ProposeAll` coexisted. Cover:

- adding an app that is already whitelisted → `ErrNoChange`, and **no branch,
  no commit, no pull request is created** (assert against the fake/recorder, not
  just the return value)
- removing an app that is not whitelisted → same
- whitelist unchanged but AppProject changed → the PR **is** opened
- whitelist changed but AppProject unchanged → the PR is opened, and the project
  file is not committed (the existing `github_test.go:332` behaviour still holds)
- a real change in both → one branch, both files committed, one PR
- the handler returns 200 and no URL on `ErrNoChange`, and **not** 502

## Criterion 6 — the review list truncates at 100

`apps/api/internal/gitops/review.go:94` requests
`/pulls?state=open&per_page=100&base=...` once and filters client-side, so past
100 open pull requests on `tesserix-k8s` it silently drops the rest. Silently is
the problem: an operator sees a shorter list, not an error.

Paginate properly — follow `Link: rel="next"`, or page until a short page
returns. Bound the loop so a pathological repository cannot spin forever, and if
the bound is hit, say so rather than returning a quietly truncated list.

Two sibling calls at `review.go:116` and `:126` fetch a single pull request's
files and reviews with the same `per_page=100`. They are **out of scope** — a
single PR with more than 100 files or reviews is a different problem — but note
them in a comment so the next reader knows the choice was deliberate.

### Tests

- a single short page → all items, one request
- two pages → all items, requests continue until exhausted
- the loop bound is respected and reports truncation rather than hiding it

## Verification

Go: `go test ./...` and `go vet ./...` from `apps/api/`.
Workspace: `pnpm lint` and `pnpm typecheck` from the repo root.
Report the ACTUAL output. Do not pipe test output through `tail -N` — that has
destroyed a failing test's name three times in this session; write to a file and
grep it.

## Commit

Single line, conventional commits, no body, no signature. Suggested:
`fix(gitops): refuse to open a pull request with no diff, and paginate the review list (tesserix-home#273)`

## Out of scope — do NOT do these

- Criterion 2 (separating whitelisting from secret creation) — UI redesign.
- Criterion 3 (two-phase granting) — the current apply-then-propose ordering has
  a stated reason; changing it is an architectural decision, not a cleanup.
- Criterion 4 (collapsing three whitelist paths into one).
- Criterion 5 (the denylist/whitelist split).
- The `Rewirer` runtime type assertion and the free-text chart path.
