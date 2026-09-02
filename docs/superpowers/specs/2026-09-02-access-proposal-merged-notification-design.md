# Notifying a proposer when their access proposal merges

**Issue:** tesserix-home#483 — the second of the two notification directions in
[the secrets absorption design](2026-08-31-console-secrets-absorption-design.md) §8.
**Date:** 2026-09-02
**Status:** design approved, not yet implemented

## Why now

§8 specifies two notification kinds. Phase 3c shipped the first:

| kind | goes to | says |
|---|---|---|
| `access_proposal_open` | holders of `rotate-credentials` | someone needs you to unblock them |
| `access_proposal_merged` | the proposer | your request is live |

The second was deferred because **its recipient could not exist**. Every mutating
call in `apps/console/lib/secrets-api.ts` targeted secrets-api's `live` group and so
required `rotate-credentials`; the only operator who could raise a proposal was one
who could already clear it, and such a person never waits. That asymmetry was #482.

**#506 removed it.** The console now calls `POST /api/access/whitelist`
(`apps/console/lib/secrets-api.ts:765`), a propose-only route, so an operator holding
`platform` alone can raise a proposal and genuinely wait on someone else. The
recipient this notification addresses now exists, which is what unblocks this work.

§8's argument for the direction stands: without it a new member reloads the Reviews
page to discover whether they are unblocked — exactly the polling the bell exists to
remove.

## What the system does not currently know

Two facts, both missing in `secrets-api`, neither obvious from the API's shape.

### 1. The proposer is not on the wire

`gitops` writes the actor into the pull request body as prose
(`internal/gitops/github.go:294` and `:373`):

```go
body := fmt.Sprintf(
    "%s\n\nRequested by %s in the secret-service console.\n\n...",
    summary, req.Actor, targetTrailer, req.Namespace, req.App,
)
```

`Actor` is the Zitadel subject (`internal/api/handlers/whitelist.go:121`,
`proposal.Actor = p.Subject`). But `parseTargets` (`internal/gitops/review.go:73`)
extracts only the `whitelist: ` trailer, and `Body` never leaves the internal
`pullResource` struct. Neither `PullRequest` nor `PullDetail` carries a requester.

`PullRequest.Author` exists but is **not** the proposer. It is `p.User.Login`
(`review.go:65`) — the owner of the token that opened the pull request, which is the
same identity for every proposal the console raises. Using it to address a
notification would send every proposer's confirmation to one person.

### 2. Merged proposals do not appear in any listing

`Pulls` queries `state=open` only (`internal/gitops/review.go:112`), so a merged
proposal leaves the list entirely.

**Correction to #483's framing:** merged proposals are unreachable *by listing*, not
unreachable outright. `pullPath` (`review.go:242`) addresses a pull request by number,
and GitHub returns merged ones there. That distinction is real but does not help here:
deriving the feed requires *discovering* which proposals merged, and nothing in the
console remembers the numbers to ask about. A listing is still needed.

## Identity matching needs no mapping layer

`proposal.Actor` is `p.Subject` (Zitadel subject). The notifications route keys its
read watermark on `session.sub` (`apps/console/app/api/notifications/route.ts:200`),
the same subject. Recipient matching is therefore a direct comparison — no identity
translation, no lookup table.

## Design

### secrets-api: put the requester on the wire

Add a trailer constant beside the existing one in `internal/gitops/review.go`:

```go
const targetTrailer    = "whitelist: "     // existing
const requesterTrailer = "requested-by: "  // new
```

Both body builders append it. The existing prose line stays — it is what a human
reviewer reads on GitHub — but the trailer becomes the parsing contract, exactly as
`whitelist: ` already is. Prose is human text that has been reworded before; a trailer
is a format the code owns.

Generalise `parseTargets` into a trailer reader used by both, and add to
`PullRequest`:

```go
RequestedBy string    `json:"requestedBy"`
MergedAt    time.Time `json:"mergedAt"`
```

`Author` is deliberately left alone. It is not the proposer, but the reviews queue may
display it, and renaming it is not this change's business. See "Out of scope" below.

### secrets-api: reach merged proposals

New `MergedPulls(ctx, since time.Time)` in `review.go`:

```
GET /repos/{owner}/{repo}/pulls?state=closed&base={branch}
    &sort=updated&direction=desc&per_page=100&page=N
```

filtered to pull requests whose `Head.Ref` carries `branchPrefix` and whose
`merged_at` is non-null — closed-without-merging is a rejected proposal and must not
produce a "your request is live" notification.

**The walk is bounded by time, not by page count, and that is deliberate.** The
existing `Pulls` uses `maxPullPages` because a thousand simultaneously *open* pull
requests is an incident, not a review queue — the bound describes a state that should
never occur. Closed pull requests carry no such ceiling: they accumulate forever, so
a page bound would silently begin missing recent merges as history grows. That is the
same quietly-truncated-list failure `Pulls`' own comment says the walk exists to
remove. Walking until `updated_at` precedes `since` bounds the work by the window the
caller actually asked for.

Exposed as `GET /api/reviews/merged?since=<RFC3339>` in the `read` group — the same
`platform` gate as `/api/reviews`.

### console: a notification addressed to a person

`fetchMergedProposals(since, signal)` in `lib/secrets-api.ts`, with the same
501/503-tolerant treatment as the proposals leg (`SECRETS_API_ORIGIN` unset answers
501 before any network call; no review repository configured answers 503; neither is
a bug and neither may cost the operator their ticket rows). Capped at `FEED_LIMIT`,
`since` derived from `FEED_WINDOW_DAYS`.

`access_proposal_merged` joins `NOTIFICATION_KINDS`. The union's `assertNever` guard
in the bell makes an unhandled variant a compile error, so the type system enforces
the rendering half.

The one structural change is visibility. Today:

```ts
function visibleTo(item, capabilities) {
  return capabilities.has(CAPABILITY_FOR_KIND[item.kind]);
}
```

This cannot express "addressed to one person." Items gain an optional `recipientSub`;
when it is present, visibility requires `recipientSub === auth.sub` **in addition to**
the capability check. Capability-addressed kinds are unchanged — they carry no
`recipientSub` and keep exactly today's behaviour.

`CAPABILITY_FOR_KIND` gains `access_proposal_merged: "platform"`. Not
`rotate-credentials`: the proposer this serves holds `platform` and, by the premise of
#506, may hold nothing else. Gating their own confirmation behind the verb they lack
would make the notification unreachable by precisely the person it is for.

### Read state: unchanged

`console_notification_reads` keeps one watermark per `user_id`, shared across kinds.
No migration, no new columns.

The accepted cost: a busy operator opening the bell for ticket traffic marks the
merged item seen along with everything else. Per-kind watermarks would be more
faithful, but they mean a schema migration — which in this estate must be applied to
production *before* the PR merges — and that is a large bill for a low-frequency,
non-urgent, self-caused notification. The operator asked for this access; they are not
learning of it cold.

### Degradation

Proposals already open carry no `requested-by: ` trailer, so `requestedBy` parses
empty. **An empty requester must never match any recipient — not match everyone.**
This is the security-relevant edge of the whole change: the failure mode is one
operator seeing another's activity. It gets an explicit test with the mutation
applied.

The outcome for pre-existing proposals is that merging them produces no notification.
That is correct and needs no backfill: the notification answers "your request is
live," and nobody is waiting on a bell that did not exist when they filed.

## Testing

Go (`internal/gitops`):
- requester trailer round-trips through body construction and parsing, for both the
  whitelist and wiring builders
- `MergedPulls` rejects closed-but-not-merged pull requests
- `MergedPulls` rejects merged pull requests whose branch lacks `branchPrefix`
- `MergedPulls` stops walking at `since` rather than at a page count
- `MergedPulls` paginates rather than reading only the first page

TypeScript (`apps/console`):
- an item with `recipientSub` is hidden from a different subject
- an item with `recipientSub` is shown to the matching subject
- **an item with an empty `requestedBy` is shown to nobody** — the mutation is to make
  empty match, and the test must fail under it
- capability-addressed kinds are unaffected by the recipient check
- the merged leg's 501/503/timeout failures do not cost the feed its other legs

Every test is mutated before it is trusted. The estate's recurring defect is
assertions that cannot fail — most sharply, `queryByRole("link")` not matching
`<a href="">`, which is exactly what the bug it guarded would render. Each test above
states the mutation that must break it.

## Deployment

secrets-api first, console second. The secrets-api change is additive — a new JSON
field and a new route — so a console still running the previous build is unaffected,
and the new console degrades to an empty merged leg against an old secrets-api because
the 501/503 tolerance already covers an endpoint that answers nothing useful.

No schema migration, so the apply-to-production-before-merge rule does not apply here.
Stated explicitly because in this repository it usually does.

## A documentation correction this change carries

[The cutover design](2026-09-01-secrets-console-cutover-design.md) §9's table lists
step 4 ("Notifications (§8 of the predecessor)") as a console-only change that deploys
on merge. That is accurate for everything phase 3c shipped and **wrong for this
direction**, which cannot ship without the two secrets-api changes above. The table is
corrected as part of this work so the next reader does not re-derive it.

## Out of scope

- **`PullRequest.Author` is misleading.** It is the token owner, identical across every
  proposal. This design routes around it rather than fixing it, because what it
  actually exposes is that proposals are raised by a named person's PAT — which is
  tesserix-home#464, and a credential decision rather than a notification one.
- **Per-kind or per-item read state.** Revisit if the shared watermark proves to
  swallow these in practice.
- **Backfilling notifications for proposals open before this ships.**
