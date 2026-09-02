# Access Proposal Merged Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell an operator, in the console bell, that the access proposal they raised has merged and their app now has a reader.

**Architecture:** `secrets-api` gains a machine-readable `requested-by: ` trailer on the pull requests it opens and a `MergedPulls` listing that walks closed pull requests backwards until a time bound. The console adds an `access_proposal_merged` notification kind whose visibility requires the item's `recipientSub` to equal the viewing operator's `session.sub`, in addition to the existing capability check. No new persistence; the feed stays computed-on-request.

**Tech Stack:** Go 1.26 + Gin (secrets-api), Next.js 16 + React 19 + TypeScript + Vitest (apps/console), GitHub REST API.

**Spec:** `docs/superpowers/specs/2026-09-02-access-proposal-merged-notification-design.md`

## Global Constraints

- Repository is **pnpm**, never npm: `pnpm install --frozen-lockfile`, then `pnpm -r --filter "./packages/**" build` before any console test run, or ~35 tests fail phantom.
- The proposer identity is the **Zitadel subject**: `p.Subject` in secrets-api, `session.sub` in the console. Never `PullRequest.Author` (the PAT owner, identical for every proposal).
- An **empty `requestedBy` must match no recipient**. Never treat absent as wildcard.
- `NOTIFICATION_KINDS` is the compiler-enforced source of truth; the `NotificationKind` union derives from it, never the reverse.
- Every test must be **mutated before it is trusted**: apply the stated mutation, watch the test fail, revert. A test that passes under its own mutation is a plan failure, not a passing test.
- Deploy order is **secrets-api first, console second**. No schema migration in this work.
- Commits are single-line, conventional, no signatures.

---

### Task 1: Write the proposer into the pull request as a parseable trailer

**Files:**
- Modify: `secrets-api/internal/gitops/review.go` (add `requesterTrailer`, generalise `parseTargets`, add `RequestedBy` to `PullRequest`)
- Modify: `secrets-api/internal/gitops/github.go:294` and `:373` (append the trailer to both bodies)
- Test: `secrets-api/internal/gitops/github_test.go`, `secrets-api/internal/gitops/review_test.go`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `const requesterTrailer = "requested-by: "`; `func trailerValue(body, prefix string) string`; `PullRequest.RequestedBy string` with JSON tag `requestedBy`.

- [ ] **Step 1: Write the failing tests**

In `secrets-api/internal/gitops/review_test.go`:

```go
func TestTrailerValueReadsRequester(t *testing.T) {
	body := "summary\n\nRequested by 291837.\n\nrequested-by: 291837\nwhitelist: ns/app"
	if got := trailerValue(body, requesterTrailer); got != "291837" {
		t.Fatalf("requester = %q, want %q", got, "291837")
	}
}

func TestTrailerValueAbsentIsEmpty(t *testing.T) {
	// A proposal opened before this shipped carries no trailer. Empty is the
	// only safe answer: it must match no recipient downstream.
	if got := trailerValue("summary\n\nwhitelist: ns/app", requesterTrailer); got != "" {
		t.Fatalf("requester = %q, want empty", got)
	}
}

func TestToPullRequestCarriesRequester(t *testing.T) {
	p := pullResource{Body: "s\n\nrequested-by: subject-9\nwhitelist: ns/app"}
	if got := p.toPullRequest().RequestedBy; got != "subject-9" {
		t.Fatalf("RequestedBy = %q, want %q", got, "subject-9")
	}
}

func TestParseTargetsStillWorks(t *testing.T) {
	// The generalisation must not disturb the existing trailer.
	got := parseTargets("s\n\nrequested-by: x\nwhitelist: ns/a, ns/b")
	if len(got) != 2 || got[0] != "ns/a" || got[1] != "ns/b" {
		t.Fatalf("targets = %v, want [ns/a ns/b]", got)
	}
}
```

In `secrets-api/internal/gitops/github_test.go`, extend the existing body assertions (the ones already reached via `findCall(t, *seen, http.MethodPost, "/pulls").Body["body"]`) with one test per builder:

```go
func TestProposeWiringBodyCarriesRequesterTrailer(t *testing.T) {
	// Arrange exactly as the existing wiring-proposal test in this file does,
	// with the proposal's Actor set to "subject-7", then:
	body, _ := findCall(t, *seen, http.MethodPost, "/pulls").Body["body"].(string)
	if !strings.Contains(body, "requested-by: subject-7") {
		t.Fatalf("body missing requester trailer:\n%s", body)
	}
}

func TestProposeAllBodyCarriesRequesterTrailer(t *testing.T) {
	// Arrange exactly as the existing ProposeAll test in this file does, with
	// changes[0].Actor set to "subject-7", then assert the same containment.
	body, _ := findCall(t, *seen, http.MethodPost, "/pulls").Body["body"].(string)
	if !strings.Contains(body, "requested-by: subject-7") {
		t.Fatalf("body missing requester trailer:\n%s", body)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd secrets-api && go test ./internal/gitops/ -run 'Trailer|Requester|ParseTargets' -v
```

Expected: FAIL — `undefined: trailerValue`, `undefined: requesterTrailer`, and `RequestedBy` not a field.

- [ ] **Step 3: Implement**

In `review.go`, beside the existing constant:

```go
// requesterTrailer prefixes the line naming the operator who asked for the
// change. The body already says "Requested by X" in prose for a human
// reviewer; that sentence is prose and has been reworded before, so the
// subject is stated a second time in a form the code owns — the same
// reasoning that put the apps behind targetTrailer.
const requesterTrailer = "requested-by: "
```

Generalise the parser, keeping `parseTargets` as a caller so nothing else changes:

```go
// trailerValue returns the text after the first line beginning with prefix,
// or "" when no such line exists. An absent trailer is a proposal opened
// before the trailer existed; "" is the only safe answer, because callers
// treat it as "addressed to nobody".
func trailerValue(body, prefix string) string {
	for line := range strings.SplitSeq(body, "\n") {
		if rest, found := strings.CutPrefix(strings.TrimSpace(line), prefix); found {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}

func parseTargets(body string) []string {
	rest := trailerValue(body, targetTrailer)
	if rest == "" {
		return nil
	}
	targets := make([]string, 0, 2)
	for target := range strings.SplitSeq(rest, ",") {
		if trimmed := strings.TrimSpace(target); trimmed != "" {
			targets = append(targets, trimmed)
		}
	}
	return targets
}
```

Add the field to `PullRequest` (after `Author`):

```go
	// RequestedBy is the Zitadel subject of the operator who raised this, read
	// back from the requested-by trailer. NOT Author, which is the login of
	// the token that opened the pull request and is therefore the same
	// identity for every proposal the console raises.
	RequestedBy string `json:"requestedBy"`
```

and set it in `toPullRequest`:

```go
		RequestedBy: trailerValue(p.Body, requesterTrailer),
```

In `github.go`, append the trailer to both bodies. At `:294`:

```go
	body := fmt.Sprintf(
		"%s\n\nRequested by %s in the secret-service console.\n\nThe app must already be whitelisted in the openbao chart, or External Secrets has no store to read from.\n\n%s%s\n%s%s/%s",
		summary, req.Actor, requesterTrailer, req.Actor, targetTrailer, req.Namespace, req.App,
	)
```

At `:373`:

```go
	body := fmt.Sprintf(
		"%s\n\nRequested by %s in the secret-service console.\n\nMerging this lets External Secrets reach OpenBao for the app named above. It grants no ability to read any secret value through the console.\n\n%s%s\n%s%s",
		summary, changes[0].Actor, requesterTrailer, changes[0].Actor, targetTrailer, strings.Join(targets, ", "),
	)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd secrets-api && go test ./internal/gitops/ -v
```

Expected: PASS, including every pre-existing test in the package.

- [ ] **Step 5: Mutate each new test and confirm it fails**

Required mutations, one at a time, reverting after each:
1. In `trailerValue`, `return ""` → `return "anyone"`. `TestTrailerValueAbsentIsEmpty` MUST fail. This is the security-relevant one — it is the guard against an absent requester matching every operator.
2. Drop `requesterTrailer` from the `:294` body only. `TestProposeWiringBodyCarriesRequesterTrailer` MUST fail and the `ProposeAll` one MUST still pass — proving the two builders are asserted independently rather than one test covering both.
3. In `toPullRequest`, set `RequestedBy: p.User.Login`. `TestToPullRequestCarriesRequester` MUST fail — this is the exact wrong-identity bug the design exists to avoid.

If any test passes under its mutation, the test is wrong. Fix the test, not the mutation.

- [ ] **Step 6: Commit**

```bash
git add secrets-api/internal/gitops/
git commit -m "feat(secrets-api): carry the proposer's subject on a parseable trailer (#483)"
```

---

### Task 2: List merged proposals, bounded by time

**Files:**
- Modify: `secrets-api/internal/gitops/review.go` (add `MergedAt` to `pullResource` and `PullRequest`, add `MergedPulls`)
- Test: `secrets-api/internal/gitops/review_test.go`

**Interfaces:**
- Consumes: `trailerValue`, `requesterTrailer`, `PullRequest.RequestedBy` from Task 1.
- Produces: `func (g *GitHub) MergedPulls(ctx context.Context, since time.Time) ([]PullRequest, error)`; `PullRequest.MergedAt time.Time` with JSON tag `mergedAt`.

- [ ] **Step 1: Write the failing tests**

Follow the existing table/stub-server pattern in `review_test.go` (the one used by the `Pulls` pagination test around `:221`). Each test serves `/pulls` responses from a stub and asserts on what `MergedPulls` returns.

```go
func TestMergedPullsRejectsClosedButUnmerged(t *testing.T) {
	// Two closed pull requests on secret-service branches; only one merged.
	// A rejected proposal must never produce a "your request is live" event.
	stub := []map[string]any{
		{"number": 1, "head": map[string]any{"ref": "secret-service/a"}, "merged_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z", "body": "requested-by: s1"},
		{"number": 2, "head": map[string]any{"ref": "secret-service/b"}, "merged_at": nil, "updated_at": "2026-09-01T10:00:00Z", "body": "requested-by: s2"},
	}
	got := mergedPullsFromStub(t, stub, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
	if len(got) != 1 || got[0].Number != 1 {
		t.Fatalf("got %+v, want only pull 1", got)
	}
}

func TestMergedPullsRejectsForeignBranches(t *testing.T) {
	// A human's own merged pull request against the same base is none of the
	// console's business, exactly as Pulls' branch filter already decides.
	stub := []map[string]any{
		{"number": 3, "head": map[string]any{"ref": "chore/tidy"}, "merged_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z", "body": ""},
	}
	if got := mergedPullsFromStub(t, stub, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)); len(got) != 0 {
		t.Fatalf("got %+v, want none", got)
	}
}

func TestMergedPullsStopsAtSince(t *testing.T) {
	// The walk is bounded by time, not by a page count: closed pull requests
	// accumulate forever, so a page bound would silently start missing recent
	// merges as history grows.
	stub := []map[string]any{
		{"number": 4, "head": map[string]any{"ref": "secret-service/a"}, "merged_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z", "body": "requested-by: s1"},
		{"number": 5, "head": map[string]any{"ref": "secret-service/b"}, "merged_at": "2026-01-01T10:00:00Z", "updated_at": "2026-01-01T10:00:00Z", "body": "requested-by: s2"},
	}
	got := mergedPullsFromStub(t, stub, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
	if len(got) != 1 || got[0].Number != 4 {
		t.Fatalf("got %+v, want only pull 4", got)
	}
}

func TestMergedPullsCarriesRequesterAndMergedAt(t *testing.T) {
	stub := []map[string]any{
		{"number": 6, "head": map[string]any{"ref": "secret-service/a"}, "merged_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z", "body": "requested-by: subject-9\nwhitelist: ns/app"},
	}
	got := mergedPullsFromStub(t, stub, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
	if len(got) != 1 {
		t.Fatalf("got %d pulls, want 1", len(got))
	}
	if got[0].RequestedBy != "subject-9" {
		t.Fatalf("RequestedBy = %q, want subject-9", got[0].RequestedBy)
	}
	if !got[0].MergedAt.Equal(time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("MergedAt = %v, want 2026-09-01T10:00:00Z", got[0].MergedAt)
	}
}

func TestMergedPullsRequestsClosedStateSortedByUpdated(t *testing.T) {
	// Asserts the query itself: state=open would return nothing merged, and an
	// unsorted walk cannot use `since` as its bound.
	path := capturedPathFromStub(t)
	for _, want := range []string{"state=closed", "sort=updated", "direction=desc"} {
		if !strings.Contains(path, want) {
			t.Fatalf("path %q missing %q", path, want)
		}
	}
}
```

Write `mergedPullsFromStub` and `capturedPathFromStub` as local helpers mirroring the existing stub-server helper in this file — read that helper first and follow it rather than inventing a second style.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd secrets-api && go test ./internal/gitops/ -run MergedPulls -v
```

Expected: FAIL — `g.MergedPulls undefined`.

- [ ] **Step 3: Implement**

Add to `pullResource` — nullable, because GitHub sends `null` for closed-but-unmerged and a zero `time.Time` cannot be told apart from a parse failure:

```go
	MergedAt *string `json:"merged_at"`
```

Add to `PullRequest`:

```go
	// MergedAt is when GitHub merged this. It is the notification's timestamp,
	// not CreatedAt: a proposal that waited a week in the queue would
	// otherwise produce an event dated to when it was raised, arriving older
	// than the operator's read watermark and so pre-read.
	MergedAt time.Time `json:"mergedAt"`
```

Then:

```go
// MergedPulls lists console-raised proposals merged since the given time,
// newest first.
//
// The walk is bounded by `since` rather than by a page count, and that
// differs from Pulls deliberately. Pulls' maxPullPages describes a state that
// should never occur — a thousand simultaneously OPEN pull requests is an
// incident, not a review queue. Closed pull requests carry no such ceiling:
// they accumulate for the life of the repository, so a page bound here would
// silently begin missing recent merges as history grows. That is the same
// quietly-truncated-list failure Pulls' own comment exists to remove.
func (g *GitHub) MergedPulls(ctx context.Context, since time.Time) ([]PullRequest, error) {
	out := make([]PullRequest, 0, pullPageSize)

	for page := 1; ; page++ {
		var batch []pullResource
		path := fmt.Sprintf("/repos/%s/%s/pulls?state=closed&per_page=%d&page=%d&base=%s&sort=updated&direction=desc",
			g.cfg.Owner, g.cfg.Repo, pullPageSize, page, g.cfg.Branch)
		if err := g.do(ctx, http.MethodGet, path, nil, &batch); err != nil {
			return nil, err
		}

		for _, p := range batch {
			updated, err := time.Parse(time.RFC3339, p.UpdatedAt)
			if err == nil && updated.Before(since) {
				sort.Slice(out, func(i, j int) bool { return out[i].MergedAt.After(out[j].MergedAt) })
				return out, nil
			}
			if p.MergedAt == nil || !strings.HasPrefix(p.Head.Ref, branchPrefix) {
				continue
			}
			merged, err := time.Parse(time.RFC3339, *p.MergedAt)
			if err != nil || merged.Before(since) {
				continue
			}
			pr := p.toPullRequest()
			pr.MergedAt = merged
			out = append(out, pr)
		}

		if len(batch) < pullPageSize {
			sort.Slice(out, func(i, j int) bool { return out[i].MergedAt.After(out[j].MergedAt) })
			return out, nil
		}
	}
}
```

Add `UpdatedAt string \`json:"updated_at"\`` to `pullResource` if it is not already present.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd secrets-api && go test ./internal/gitops/ -v
```

Expected: PASS.

- [ ] **Step 5: Mutate each new test and confirm it fails**

1. Drop the `p.MergedAt == nil` check. `TestMergedPullsRejectsClosedButUnmerged` MUST fail.
2. Drop the `branchPrefix` check. `TestMergedPullsRejectsForeignBranches` MUST fail.
3. Change `state=closed` to `state=all`. `TestMergedPullsRequestsClosedStateSortedByUpdated` MUST fail.
4. Set `pr.MergedAt = pr.CreatedAt`. `TestMergedPullsCarriesRequesterAndMergedAt` MUST fail — this is the pre-read-notification bug.

- [ ] **Step 6: Commit**

```bash
git add secrets-api/internal/gitops/
git commit -m "feat(secrets-api): list merged proposals bounded by time, not page count (#483)"
```

---

### Task 3: Expose the merged listing on the read group

**Files:**
- Modify: `secrets-api/internal/api/handlers/reviews.go` (route + handler)
- Test: `secrets-api/internal/api/handlers/reviews_test.go`

**Interfaces:**
- Consumes: `MergedPulls(ctx, since)` from Task 2.
- Produces: `GET /api/reviews/merged?since=<RFC3339>` answering `{"pulls": [...]}`, matching `/api/reviews`'s envelope so the console's existing `parseProposals` unwrap applies unchanged.

Route ordering note, already verified: Gin v1.12.0 accepts `/api/reviews/merged` alongside the existing `/api/reviews/:number` and matches the static segment first, so `Show` never sees `"merged"` as a number.

- [ ] **Step 1: Write the failing tests**

Follow the existing handler-test pattern in this file (a fake reviewer/lister injected into the handler).

```go
func TestMergedRequiresReadGroupOnly(t *testing.T) {
	// Same gate as /api/reviews: platform alone. A proposer who cannot merge
	// must still be able to learn that someone merged for them.
	// Assert the route is registered on g.Read, mirroring how this file's
	// existing tests assert /api/reviews' group.
}

func TestMergedDefaultsSinceWhenAbsent(t *testing.T) {
	// An absent or unparseable `since` must fall back to a bounded default
	// window, never to the zero time — the zero time would walk the whole
	// repository history on every bell poll.
	got := sinceOrDefault("", time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC))
	want := time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("since = %v, want %v", got, want)
	}
}

func TestMergedRejectsZeroTimeSince(t *testing.T) {
	got := sinceOrDefault("0001-01-01T00:00:00Z", time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC))
	if got.Year() < 2026 {
		t.Fatalf("since = %v, want clamped to the default window", got)
	}
}

func TestMergedAnswersPullsEnvelope(t *testing.T) {
	// The console's parseProposals expects {"pulls": [...]}, the same shape
	// /api/reviews already returns.
	// Serve one merged pull through the handler and assert the decoded body
	// has a "pulls" key holding one entry.
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd secrets-api && go test ./internal/api/handlers/ -run Merged -v
```

Expected: FAIL — `sinceOrDefault` undefined and the route unregistered.

- [ ] **Step 3: Implement**

```go
// mergedWindow bounds how far back the merged listing will walk when the
// caller names no window. It matches the console feed's FEED_WINDOW_DAYS;
// an unbounded default would walk the repository's whole closed history on
// every bell poll.
const mergedWindow = 14 * 24 * time.Hour

func sinceOrDefault(raw string, now time.Time) time.Time {
	floor := now.Add(-mergedWindow)
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil || parsed.Before(floor) {
		return floor
	}
	return parsed
}

func (h *Reviews) Merged(c *gin.Context) {
	pulls, err := h.lister.MergedPulls(c.Request.Context(), sinceOrDefault(c.Query("since"), time.Now()))
	if err != nil {
		// Mirror this file's existing error handling for List.
		return
	}
	c.JSON(http.StatusOK, gin.H{"pulls": pulls})
}
```

Register beside the existing routes, before the `:number` route for readability (ordering does not affect matching):

```go
	g.Read.GET("/api/reviews/merged", h.Merged)
```

Add `MergedPulls` to whatever interface `h.lister` satisfies, and to the test fake.

- [ ] **Step 4: Run to verify pass, then run the whole service suite**

```bash
cd secrets-api && go test ./... 2>&1 | tee /tmp/483-go.log; grep -c '^--- SKIP' /tmp/483-go.log
```

Expected: PASS. **Count the SKIPs.** This repository's Go suites silently skip database-backed tests when `TESSERIX_TEST_DB_*` is unset — 51 packages can report `ok` while 41 tests never run. If the skip count is non-zero, say so explicitly in the task report rather than reporting a green suite.

- [ ] **Step 5: Mutate**

1. `return floor` → `return time.Time{}` in the error branch. `TestMergedRejectsZeroTimeSince` and `TestMergedDefaultsSinceWhenAbsent` MUST fail.
2. Register the route on `g.Live` instead of `g.Read`. `TestMergedRequiresReadGroupOnly` MUST fail.
3. Answer the bare array instead of the envelope. `TestMergedAnswersPullsEnvelope` MUST fail.

- [ ] **Step 6: Commit**

```bash
git add secrets-api/internal/api/handlers/
git commit -m "feat(secrets-api): serve merged proposals on GET /api/reviews/merged (#483)"
```

---

### Task 4: Read the merged listing from the console

**Files:**
- Modify: `apps/console/lib/secrets.ts` (`Proposal` gains two optional fields; `parseProposalFields` reads them)
- Modify: `apps/console/lib/secrets-api.ts` (add `fetchMergedProposals`)
- Test: `apps/console/lib/secrets.test.ts`, `apps/console/lib/secrets-api.test.ts`

**Interfaces:**
- Consumes: the `{"pulls":[…]}` envelope with `requestedBy` and `mergedAt` from Task 3.
- Produces: `Proposal.requestedBy?: string`, `Proposal.mergedAt?: string`; `fetchMergedProposals(sinceIso: string, signal?: AbortSignal): Promise<Proposal[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("reads requestedBy and mergedAt off a merged proposal", () => {
  const [p] = parseProposals({
    pulls: [{ number: 4, title: "t", url: "u", branch: "b", author: "bot",
              targets: [], requestedBy: "subject-9", mergedAt: "2026-09-01T10:00:00Z" }],
  });
  expect(p.requestedBy).toBe("subject-9");
  expect(p.mergedAt).toBe("2026-09-01T10:00:00Z");
});

it("leaves requestedBy undefined on a proposal raised before the trailer existed", () => {
  const [p] = parseProposals({
    pulls: [{ number: 5, title: "t", url: "u", branch: "b", author: "bot", targets: [] }],
  });
  expect(p.requestedBy).toBeUndefined();
});

it("requests the merged listing with the since window", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ pulls: [] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await fetchMergedProposals("2026-08-19T00:00:00Z");
  const url = fetchMock.mock.calls[0][0] as string;
  expect(url).toBe("http://secrets/api/reviews/merged?since=2026-08-19T00%3A00%3A00Z");
});
```

Match the existing stubbing style in `secrets-api.test.ts` (see its `/api/access/whitelist` test around `:919`) rather than introducing a new one.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter console test -- secrets.test.ts secrets-api.test.ts
```

Expected: FAIL — `fetchMergedProposals` is not exported; `requestedBy` is not on `Proposal`.

- [ ] **Step 3: Implement**

In `secrets.ts`, extend `Proposal`:

```ts
  /** The Zitadel subject of the operator who raised this, from secrets-api's
   *  `requested-by:` trailer. `undefined` for proposals opened before the
   *  trailer existed — which must address nobody, never everybody. */
  readonly requestedBy?: string;
  /** When GitHub merged this, RFC3339. `undefined` for an open proposal. */
  readonly mergedAt?: string;
```

In `parseProposalFields`, add the two optional reads (absence is legal, a wrong type is not):

```ts
    requestedBy: typeof entry.requestedBy === "string" && entry.requestedBy !== ""
      ? entry.requestedBy
      : undefined,
    mergedAt: typeof entry.mergedAt === "string" && entry.mergedAt !== ""
      ? entry.mergedAt
      : undefined,
```

Go's zero `time.Time` marshals to `"0001-01-01T00:00:00Z"`, so also treat that as absent:

```ts
const ZERO_TIME = "0001-01-01T00:00:00Z";
// ...then `entry.mergedAt !== ZERO_TIME` in the guard above.
```

In `secrets-api.ts`:

```ts
/**
 * Proposals merged since `sinceIso`: `GET /api/reviews/merged`, the `read`
 * group (`platform` alone), same 501/503 reasoning as {@link fetchProposals}.
 */
export async function fetchMergedProposals(
  sinceIso: string,
  signal?: AbortSignal,
): Promise<Proposal[]> {
  const json = await secretsRequest(
    "merged reviews",
    `/api/reviews/merged?since=${encodeURIComponent(sinceIso)}`,
    { signal },
  );
  return parseProposals(json);
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter console test -- secrets.test.ts secrets-api.test.ts
```

- [ ] **Step 5: Mutate**

1. Drop the `!== ""` guard on `requestedBy`. The "raised before the trailer existed" test MUST fail (it would yield `""`, not `undefined`).
2. Drop `encodeURIComponent`. The URL test MUST fail on the unescaped colons.
3. Drop the `ZERO_TIME` guard and feed `"0001-01-01T00:00:00Z"`. Add an assertion if none fails — a zero timestamp reaching the feed sorts as a 1-year-old item and silently disappears.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/secrets.ts apps/console/lib/secrets-api.ts apps/console/lib/secrets.test.ts apps/console/lib/secrets-api.test.ts
git commit -m "feat(console): read merged proposals and their requester (#483)"
```

---

### Task 5: A notification addressed to a person, not a capability

**Files:**
- Modify: `apps/console/lib/notifications.ts` (new kind, new interface, `toMergedProposalEvent`)
- Test: `apps/console/lib/notifications.test.ts`

**Interfaces:**
- Consumes: `Proposal.requestedBy`, `Proposal.mergedAt` from Task 4.
- Produces: `"access_proposal_merged"` in `NOTIFICATION_KINDS`; `interface AccessProposalMergedNotification` with `recipientSub: string`; `toMergedProposalEvent(proposal: Proposal): AccessProposalMergedNotification | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
it("builds a merged event addressed to the requester", () => {
  const event = toMergedProposalEvent({
    number: 7, title: "grant ns/app", url: "u", branch: "b", author: "bot",
    targets: ["ns/app"], requestedBy: "subject-9", mergedAt: "2026-09-01T10:00:00Z",
  });
  expect(event).toEqual({
    id: "access_proposal_merged:7",
    kind: "access_proposal_merged",
    number: 7,
    title: "grant ns/app",
    targets: ["ns/app"],
    recipientSub: "subject-9",
    at: "2026-09-01T10:00:00Z",
  });
});

it("builds nothing for a proposal with no requester", () => {
  // The security-relevant case: an unaddressed item must not exist at all,
  // because an item with no recipient cannot be filtered to one.
  expect(toMergedProposalEvent({
    number: 8, title: "t", url: "u", branch: "b", author: "bot",
    targets: [], mergedAt: "2026-09-01T10:00:00Z",
  })).toBeUndefined();
});

it("builds nothing for a proposal with no merge time", () => {
  expect(toMergedProposalEvent({
    number: 9, title: "t", url: "u", branch: "b", author: "bot",
    targets: [], requestedBy: "subject-9",
  })).toBeUndefined();
});

it("lists the merged kind so the bell's shape validator accepts it", () => {
  expect(NOTIFICATION_KINDS).toContain("access_proposal_merged");
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter console test -- notifications.test.ts
```

- [ ] **Step 3: Implement**

Add to `NOTIFICATION_KINDS` (the array is the source of truth; the union derives from it):

```ts
  "access_proposal_merged",
```

```ts
/**
 * A proposal the viewing operator raised has merged: their app now has a
 * reader. Unlike every other kind, this one is addressed to a PERSON — the
 * capability check alone cannot express "yours" — so it carries the subject
 * it is for and route.ts requires that subject to match the session.
 */
export interface AccessProposalMergedNotification {
  readonly id: string;
  readonly kind: "access_proposal_merged";
  readonly number: number;
  readonly title: string;
  readonly targets: string[];
  /** The Zitadel subject this is FOR. Never optional: an item that cannot
   *  name its recipient must not be built — see toMergedProposalEvent. */
  readonly recipientSub: string;
  /** The MERGE time, not the creation time. A proposal that waited a week
   *  would otherwise arrive older than the read watermark and so pre-read. */
  readonly at: string;
}

export type NotificationItem =
  | TicketNotification
  | AccessProposalNotification
  | AccessProposalMergedNotification;

/**
 * Maps a merged proposal to its notification, or `undefined` when the
 * proposal cannot support one.
 *
 * Returning `undefined` rather than a partly-filled item is the point: a
 * proposal raised before the `requested-by:` trailer existed has no
 * requester, and an item with no recipient cannot be filtered to one — it
 * would either reach everybody or nobody, and "everybody" is one operator
 * seeing another's activity.
 */
export function toMergedProposalEvent(
  proposal: Proposal,
): AccessProposalMergedNotification | undefined {
  if (!proposal.requestedBy || !proposal.mergedAt) return undefined;
  return {
    id: `access_proposal_merged:${proposal.number}`,
    kind: "access_proposal_merged",
    number: proposal.number,
    title: proposal.title,
    targets: proposal.targets,
    recipientSub: proposal.requestedBy,
    at: proposal.mergedAt,
  };
}
```

`notification-bell.tsx` will now fail to compile at its `assertNever` switches. Add the rendering branch there: the item reads as "Your request for <targets> is live", linking to the same review route the open kind uses. Follow the existing branch's markup exactly.

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter console test -- notifications.test.ts && pnpm --filter console exec tsc --noEmit
```

- [ ] **Step 5: Mutate**

1. `if (!proposal.requestedBy || !proposal.mergedAt) return undefined;` → drop the `requestedBy` half. The "no requester" test MUST fail.
2. `at: proposal.mergedAt` → `at: proposal.createdAt`. The first test MUST fail.
3. Remove `"access_proposal_merged"` from `NOTIFICATION_KINDS`. The listing test MUST fail AND `tsc --noEmit` MUST error — confirming the array really is the enforced source of truth this file's comment claims.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/notifications.ts apps/console/lib/notifications.test.ts apps/console/components/**/notification-bell.tsx
git commit -m "feat(console): add the merged-proposal notification kind (#483)"
```

---

### Task 6: Require the recipient to match, and wire the leg in

**Files:**
- Modify: `apps/console/app/api/notifications/route.ts` (`CAPABILITY_FOR_KIND`, `visibleTo`, a `safeMergedProposalEvents` leg, the `Promise.all`)
- Test: `apps/console/app/api/notifications/route.test.ts`

**Interfaces:**
- Consumes: `toMergedProposalEvent` from Task 5, `fetchMergedProposals` from Task 4.
- Produces: no new exports; changes `visibleTo(item, capabilities)` to `visibleTo(item, capabilities, sub)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("hides a merged notification from an operator who is not its recipient", async () => {
  // Two operators, one merged proposal raised by subject-9.
  // Viewing as subject-OTHER must yield no access_proposal_merged item.
});

it("shows a merged notification to the operator who raised it", async () => {
  // Viewing as subject-9 must yield exactly one.
});

it("leaves capability-addressed kinds unaffected by the recipient check", async () => {
  // A ticket_created item carries no recipientSub and must still reach a
  // support holder.
});

it("keeps the ticket rows when the merged leg fails", async () => {
  // The merged leg throwing (501/503/timeout) must not cost the other legs,
  // exactly as safeProposalEvents already guarantees.
});
```

Follow the existing route test's harness for session and capability stubbing.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter console test -- route.test.ts
```

- [ ] **Step 3: Implement**

```ts
const CAPABILITY_FOR_KIND: Record<NotificationKind, Capability> = {
  ticket_created: "support",
  merchant_reply: "support",
  access_proposal_open: "rotate-credentials",
  // `platform`, NOT `rotate-credentials`. This kind's recipient is the
  // operator who raised the proposal and could not clear it — by the premise
  // of #506 they hold `platform` and may hold nothing else. Gating their own
  // confirmation behind the verb they lack would make it unreachable by
  // exactly the person it is for.
  access_proposal_merged: "platform",
};
```

```ts
/**
 * Capability admits a KIND; `recipientSub` admits a PERSON. Both must pass.
 *
 * The capability check alone cannot express "yours": every `platform` holder
 * would see every merged proposal, which is one operator reading another's
 * activity. Items with no `recipientSub` are capability-addressed and keep
 * exactly their previous behaviour.
 */
function visibleTo(
  item: NotificationItem,
  capabilities: ReadonlySet<Capability>,
  sub: string,
): boolean {
  if (!capabilities.has(CAPABILITY_FOR_KIND[item.kind])) return false;
  return "recipientSub" in item ? item.recipientSub === sub : true;
}
```

Add the leg, mirroring `safeProposalEvents` exactly — including its `PROPOSALS_TIMEOUT_MS` abort and its catch-to-`[]`:

```ts
async function safeMergedProposalEvents(since: Date): Promise<NotificationItem[]> {
  // Same reasoning as safeProposalEvents: this leg's failure is "nothing to
  // say right now", and must never cost the ticket rows in the same response.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROPOSALS_TIMEOUT_MS);
    try {
      const merged = await fetchMergedProposals(since.toISOString(), controller.signal);
      return merged
        .map(toMergedProposalEvent)
        .filter((e): e is AccessProposalMergedNotification => e !== undefined)
        .slice(0, FEED_LIMIT);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}
```

Wire it into the `Promise.all` and the sources array, and pass `auth.sub` through the filter:

```ts
    const [ticketRows, replyRows, proposalEvents, mergedEvents, lastSeenAt] = await Promise.all([
      recentTicketRows(since, FEED_LIMIT),
      recentMerchantReplyRows(since, FEED_LIMIT),
      safeProposalEvents(),
      safeMergedProposalEvents(since),
      readLastSeenAt(auth.sub),
    ]);
    const sources = [
      ticketRows.map(toTicketEvent),
      replyRows.map(toReplyEvent),
      proposalEvents,
      mergedEvents,
    ].map((source) => source.filter((item) => visibleTo(item, auth.capabilities, auth.sub)));
```

- [ ] **Step 4: Run the full console suite**

```bash
pnpm -r --filter "./packages/**" build && pnpm --filter console test && pnpm --filter console exec next build
```

`next build` is not optional: `tsc` and Vitest cannot see server-only code reaching the browser bundle, and this task adds imports to a route that the bell renders against.

- [ ] **Step 5: Mutate**

1. `return "recipientSub" in item ? item.recipientSub === sub : true;` → `return true`. The "hides from a non-recipient" test MUST fail. **This is the security assertion of the whole change** — if it passes under this mutation, the test is checking nothing.
2. `item.recipientSub === sub` → `item.recipientSub !== ""`. The same test MUST fail.
3. Make `safeMergedProposalEvents` rethrow instead of returning `[]`. The "keeps the ticket rows" test MUST fail.

- [ ] **Step 6: Commit**

```bash
git add apps/console/app/api/notifications/
git commit -m "feat(console): notify a proposer when their access proposal merges (#483)"
```

---

### Task 7: Correct the cutover design's sequencing table

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-secrets-console-cutover-design.md` §9

- [ ] **Step 1: Read §9's table and locate step 4**

```bash
grep -n 'Notifications' docs/superpowers/specs/2026-09-01-secrets-console-cutover-design.md
```

- [ ] **Step 2: Correct the row**

Step 4 ("Notifications (§8 of the predecessor)") is listed as console-only, deploying on merge. That is true of what phase 3c shipped and false of the merged direction. Replace the row's note with:

> Console-only for `access_proposal_open`. `access_proposal_merged` additionally requires the `requested-by:` trailer and `GET /api/reviews/merged` in secrets-api, which must deploy first — see the [merged-notification design](2026-09-02-access-proposal-merged-notification-design.md).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-01-secrets-console-cutover-design.md
git commit -m "docs: the merged-proposal notification is not console-only (#483)"
```

---

## Deployment and live verification

1. Open the PR. Merge once green.
2. secrets-api deploys first. Confirm the new route answers before the console build lands: a `401` proves it is deployed, a `404` proves it is not — the image is distroless, so port-forward rather than exec.
3. Console deploys second, via Kargo. Expect the pull-through-mirror stall (#494); the one-command unstick is on that issue.
4. Live check in Chrome: as a `platform`-only operator, confirm a merged proposal they raised appears in the bell and that an operator who did not raise it does not see it.
