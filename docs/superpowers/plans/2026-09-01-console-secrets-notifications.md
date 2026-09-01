# Console secrets notifications — Implementation Plan (phase 3c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A proposal waiting on someone reaches them through the bell they already have, and the bell stops showing anyone notifications they cannot act on.

**Architecture:** `NotificationItem` becomes a discriminated union on `kind`; `/api/notifications` drops from a single `support` gate to console entry plus per-kind capability filtering; a new `access_proposal_open` kind is derived from the open-proposal list the reviews queue already reads.

**Tech Stack:** Next.js 16 App Router (React 19, a client bell + a route handler), TypeScript, SWR, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-console-secrets-absorption-design.md` **§8** — read it in full before Task 3; this plan implements it and does not restate it. Sequencing is `docs/superpowers/specs/2026-09-01-secrets-console-cutover-design.md` §9 step 4, and its §10 paragraph beginning *"Before the union lands"* is why Task 1 exists.

## Scope

3a shipped the inventory, 3b-i inspect and write, 3b-ii access + destroy + the reviews queue (#480, #481). This is **3c**, the last console phase before the chart cutover. The surface stays **unlisted** throughout; the bell itself is already listed and already ships, which is exactly why Task 1 comes first.

---

## The ruling that sets this phase's scope

**§8 names two notification kinds. Only one of them has a recipient who can exist.**

| kind | goes to | ships in 3c? |
|---|---|---|
| `access_proposal_open` | holders of `rotate-credentials` | **yes** |
| `access_proposal_merged` | the proposer | **no — deferred, see below** |

§8's argument for the second direction is that without it *"a new member reloads the Reviews page to discover whether they are unblocked."* That new member is an operator who holds `platform`, raises a proposal, and cannot approve it. **No such person can exist through this console today.**

Verified, not assumed. Every mutating call in `apps/console/lib/secrets-api.ts` — `createGrant`, `revokeGrant`, `deleteSecret`, `approveProposal`, `mergeProposal`, `rejectProposal` — targets a route in `secrets-api`'s `live` group and therefore requires `rotate-credentials`. The console never calls `POST /api/access/whitelist` or `POST /api/access/wiring`, the only two propose-only routes. So the only operator who can raise a proposal is one who can already clear it.

That is the #482 asymmetry, filed from 3b-ii. **The merged direction becomes implementable when #482 lands, and not before.** Building it now would mean building a notification nobody can receive, and doing so would need two `secrets-api` changes it does not currently have (below).

**Two things a future implementer must know, because the spec does not say them and they are not obvious:**

1. **The proposer's identity is not on the wire.** `gitops` writes `"Requested by {actor}"` into the pull request body (`internal/gitops/github.go:294` and `:373`, actor being the Zitadel subject), but `parseTargets` extracts only the `whitelist: ` trailer and `Body` never leaves the internal `pullResource` struct. Neither `PullRequest` nor `PullDetail` carries a requester field. Addressing a notification to the proposer requires parsing it out and adding it to the JSON.
2. **Merged proposals are unreachable.** `Pulls` queries `state=open` (`internal/gitops/review.go:112`). A merged proposal leaves the list entirely; there is no endpoint that returns one. Detecting a merge requires a new query or a new endpoint.

Cutover design §9's table lists step 4 as a console-only deploy. That is wrong for the merged direction and right for everything in this plan. Task 6 files it.

---

## What this phase actually changes

Three things, in this order, and the order is the point.

**1. The ticket path gets tests before the type it rides on is touched.** Cutover §10: *"Tickets render through the type that is being changed, and a bell regression in the same release as the secrets cutover would be hard to bisect."* The bell is on every console page, listed, and shipping today. Its current render tests exercise exactly one variant.

**2. `NotificationItem` becomes a discriminated union on `kind`.** It is ticket-shaped — `ticketId`, `ticketNumber`, `productId` and `subject` all required — and an access proposal has none of them. §8: *"Widening every field to optional would push the shape check into each renderer; a union keeps the boundary honest."*

**3. The feed becomes per-capability filtered, not single-gated.** `authorize()` requires `support` today, with the reason in place: *"the bell's feed is ticket and reply rows, so it carries support data."* That reason stops holding the moment the feed carries a second kind answering to a different capability. §8: keeping one gate produces **both** failures at once — a `support` holder sees approvals they cannot act on, and someone holding `rotate-credentials` but not `support` is refused the whole feed.

## Global Constraints

- **A notification the recipient cannot act on is noise, and noise in a bell is how people learn to ignore it.** Filtering happens on the **server**, in the route. `apps/console/lib/auth/operator.ts` is `import "server-only"` precisely so the bell cannot do this itself, and `app/api/search/route.ts:32-37` records why a client-side filter is discoverability and not access control. The route stays the boundary.
- **`countUnread` must run AFTER filtering**, or the badge counts items the operator will not find in the panel. It currently counts every item indiscriminately (`lib/notifications.ts:100`).
- **The secrets leg must not be able to take down the ticket feed.** `secrets-api` answers 501 today (origin unset) and will answer 503 when no review repository is configured. Either must cost the operator the proposals section and nothing else.
- **`console_notification_reads` holds ONE watermark per `user_id`** (`lib/db/notifications-repo.ts:66-77`). Per-kind unread would need a schema change. One shared watermark is accepted for this phase — say so in a comment, do not silently rely on it.
- Boundary validation stays explicit — never a cast. The bell's own `isNotificationFeedShape` (`notification-bell.tsx:63`) deliberately does not inspect `items[]`; a union makes that gap load-bearing, so Task 2 closes it.
- **Every test is mutated before it is trusted**: make it fail for the reason it claims to guard, confirm an *assertion* failure rather than a compile error, then restore. Ask of every check: **what would make this fail?** Three checks that could not fail shipped during 3b-ii and every one was caught by mutation, never by reading.
- **Comments must state the real reason.** Two comments in this subsystem are already stale and must be fixed rather than propagated: `app/api/notifications/route.ts:23-24` says *"Both assert `read`"* when the code asserts `support`, and `route.test.ts` has two cases named *"refuses a session without the read capability"* testing a `support` gate.
- Commit messages: single line, conventional-commit prefix, no signature, no `Co-Authored-By` trailer.
- Each task verifies with `pnpm --filter console test:unit`, `pnpm --filter console exec tsc --noEmit`, and — for any task touching a page or component — `pnpm --filter console exec next build`. Never `tail -N` test output.

---

### Task 1: Cover the ticket path, before touching the type

**Files:** modify `apps/console/components/nav/notification-bell.render.test.tsx`, `apps/console/lib/notifications.test.ts`

No production change. This task exists because cutover §10 requires it, and because the coverage gaps are real: the bell's render tests share one `merchant_reply` fixture, so **`ticket_created`'s `"New ticket"` phrase has never rendered in a test**, and neither has the badge's `9+` overflow.

- [ ] **Step 1: Add the missing ticket-path render tests**

- A `ticket_created` item renders `New ticket · {ticketNumber}` — the other half of `leadingPhrase`'s ternary (`notification-bell.tsx:91`).
- A `merchant_reply` item renders `{actor} replied · {ticketNumber}` (assert the composed string, not just the actor).
- `unread` above `DISPLAY_CAP` renders the badge as `9+` while the accessible name still carries the true count (`notification-bell.tsx:173-174`) — these deliberately differ, and nothing tests it.
- Each row links to `/platform/tickets/{ticketId}` by **uuid, not number**.

- [ ] **Step 2: Mutate each one**

Swap the ternary's two branches; drop the `DISPLAY_CAP` cap; link by `ticketNumber` instead of `ticketId`. Each must produce an assertion failure. Report what you observed.

**Verify:** unit tests, `tsc --noEmit`.

---

### Task 2: `NotificationItem` becomes a discriminated union

**Files:** modify `apps/console/lib/notifications.ts` + test, `apps/console/components/nav/notification-bell.tsx` + render test

**Behaviour-neutral.** No new kind here — the union is introduced with the two existing ticket kinds so the refactor and the new kind are separately bisectable.

**Interfaces:**
```ts
interface TicketNotification { kind: "ticket_created" | "merchant_reply"; id; ticketId; ticketNumber; productId; subject; actor; at }
type NotificationItem = TicketNotification;   // Task 4 adds the second member
```
Keep every field `readonly`.

- [ ] **Step 1: Introduce the union and make the renderers exhaustive**

`leadingPhrase` (`notification-bell.tsx:90-92`) is a binary ternary and `NotificationRow` (`:94-109`) hard-codes `/platform/tickets/${item.ticketId}` for **every** item. Both become switches over `kind` that a new variant cannot silently fall through — the href and the title line must be decided per variant, not assumed.

Prefer a form where adding a variant without handling it is a **compile** error (an exhaustive switch with a `never` check). That is the one place a type error is the right guard rather than a weak test, because the failure it prevents is a variant rendering as a broken ticket link.

- [ ] **Step 2: Close the validator gap**

`isNotificationFeedShape` (`notification-bell.tsx:63-71`) checks `items` is an array and `unread` is a finite number, and never inspects an element. Its own doc calls it *"proportionate… not full schema validation"* — that was proportionate when every item was the same shape. Make it reject an item carrying an unrecognised `kind`, so an unknown variant becomes the existing `UNAVAILABLE` state rather than reaching `NotificationRow` unchecked.

Keep it proportionate: this is the boundary where a malformed payload becomes a broken sidebar on every console page, so it must fall back rather than throw. Do not import a schema library.

- [ ] **Step 3: Mutate**

Feed the validator an item with `kind: "nope"` and confirm the bell renders unavailable rather than a broken row. Then remove the `kind` check and confirm the test fails with an assertion.

**Verify:** unit tests, `tsc --noEmit`, `next build`.

---

### Task 3: The feed becomes per-capability filtered

**Files:** modify `apps/console/app/api/notifications/route.ts` + test, `apps/console/lib/notifications.ts` + test

- [ ] **Step 1: Generalise the merge and fix the count**

`mergeEvents(a, b, limit)` (`lib/notifications.ts:82`) takes exactly two arrays; the feed is about to have a third source. Make it variadic or array-taking, preserving its stated invariant — *"Newest first, then truncated — truncating before sorting would drop new events from whichever source happened to be longer."*

`countUnread` must be called on the **filtered** list. Add a test that an operator who cannot see a kind does not have it counted; that is the assertion the badge's honesty rests on.

- [ ] **Step 2: Replace the single gate**

`authorize()` (`route.ts:37-53`) returns `{ sub }` after one `checkOperatorCapabilityLive(session, "support")`. It must instead admit anyone who may enter the console and report **which capabilities they hold**, so each kind can be filtered by the capability it answers to.

Two ways to resolve the set, and the difference matters:
- N sequential `checkOperatorCapabilityLive` calls — one store resolution each, and `resolveLiveCapabilities` is not memoised (only `resolvePlatformApiToken` is).
- One resolution, then `hasCapability` per capability — cheaper, **but it bypasses the provider and platform-operator short-circuits at `operator.ts:130-135`**, which both current operators take. If you take this route you must replicate those short-circuits, and a test must prove they still apply.

Choose, and record the real reason in a comment. Do not write "for simplicity".

**`render-path-capabilities.test.ts` still requires this file to contain `await checkOperatorCapabilityLive(` and no bare `checkOperatorCapability(`.** Whichever route you take must keep it on the right side of both assertions — the live gate is what gives #285's five-minute revocation, and §8 relies on it.

- [ ] **Step 3: Decide what an operator with no relevant capability gets**

Today a non-`support` holder gets **403 for the whole feed**. Under §8 that is exactly the failure being removed. A filtered feed should answer **200 with an empty `items` and `unread: 0`** — they may enter the console, they simply have nothing addressed to them.

This changes `route.test.ts` cases 3 and 7 (both currently named *"refuses a session without the read capability"* — a name that was already wrong). Rewrite them to assert the new contract and rename them to say what they now test. **Keep a 403 for a null session**; entry still requires a session.

- [ ] **Step 4: Fix the two stale comments**

`route.ts:23-24` claims *"Both assert `read`"*. Replace it with what is now true. The old `authorize()` comment — *"the bell's feed is ticket and reply rows, so it carries support data"* — was accurate for a single-kind feed and stops being accurate here; the ticket kinds still answer to `support`, and that is what the new comment should say.

- [ ] **Step 5: Mutate**

Remove the `support` filter and confirm a `platform`-only operator now wrongly receives ticket rows. Restore. This is the assertion that proves the filter exists.

**Verify:** unit tests, `tsc --noEmit`.

---

### Task 4: The `access_proposal_open` kind

**Files:** modify `apps/console/lib/notifications.ts` + test, `apps/console/app/api/notifications/route.ts` + test

**Interfaces:**
```ts
interface AccessProposalNotification { kind: "access_proposal_open"; id; number; title; targets; at }
type NotificationItem = TicketNotification | AccessProposalNotification;
```

**Source: `fetchProposals()` from `@/lib/secrets-api`**, which 3b-ii shipped and the reviews queue already uses. It returns open pull requests only, which is exactly this kind's meaning. **Do not add a `secrets-api` endpoint** — see the scope ruling.

`id` follows the existing convention (`lib/notifications.ts:56, 69`): `` `access_proposal_open:${number}` ``. `at` is the proposal's `createdAt`, **which can be `undefined`** — Task 7 of the previous phase mapped Go's zero time to absent, and `mergeEvents` sorts on `at`. Decide what an item with no timestamp does in a newest-first list and say why; do not let it sort as the empty string by accident.

- [ ] **Step 1: The mapper and its tests**

- [ ] **Step 2: Wire it into the route, gated on `rotate-credentials`**

Filtered by the verb, not by `platform`. The capability module's own reasoning applies: *"the risk verbs are what separate reading the uptime board from rotating a live credential."* Someone holding `platform` but not `rotate-credentials` cannot clear a proposal, so telling them one is waiting is the noise §8 exists to remove.

- [ ] **Step 3: The secrets leg must fail alone**

`secrets-api` answers **501** today (`SECRETS_API_ORIGIN` unset) and **503** when no review repository is configured. Neither may cost the operator their ticket notifications. The proposals leg gets its own error containment, and a test must prove the ticket rows still arrive when it fails.

Note the asymmetry with the secret detail page, which deliberately does **not** tolerate a failed grants read: there, defaulting to empty renders "No app can read this", an alarm. Here, an absent proposals section claims nothing false. Say that in the comment — the two decisions look inconsistent and are not, and a reader who does not know why will "fix" one of them.

- [ ] **Step 4: Mutate**

Make the proposals leg reject and confirm the ticket rows still arrive and the response is 200. Then remove the containment and confirm the test fails.

**Verify:** unit tests, `tsc --noEmit`.

---

### Task 5: The bell renders the new kind

**Files:** modify `apps/console/components/nav/notification-bell.tsx` + render test

- [ ] **Step 1: The new variant's row**

It links to `/platform/secrets/reviews/{number}` — the proposal detail route 3b-ii shipped, **not** a ticket path. Copy follows §8's *"someone needs you to unblock them"* and the surrounding register: short, declarative, naming what is waiting. The targets are the useful content; the proposer's name is not available (see the scope ruling) so do not write copy that implies it is.

Task 2's exhaustive switch means this is a new `case`, not an `if`.

- [ ] **Step 2: Tests, then mutate**

Assert the row links to the proposal, not to a ticket; assert a mixed feed renders both kinds correctly. Mutate the href to the ticket path and confirm an assertion failure.

**Verify:** unit tests, `tsc --noEmit`, `next build`.

---

### Task 6: Review pass, and file the deferred direction

- [ ] Full gates: `pnpm --filter console test:unit`, `tsc --noEmit`, `next build`, root `pnpm test`. Read the whole output; do not pipe through `tail`.
- [ ] Re-read every comment added or changed against the code it sits above. The claims most likely to be stated wrongly here: why the feed dropped to console entry (a second kind answering to a different capability, **not** "the feed is less sensitive now"); why the proposals leg is tolerated while the secret page's grants leg is not (an absent section claims nothing, an empty reader list claims an alarm); and why `access_proposal_open` is gated on the verb rather than the surface.
- [ ] Confirm `render-path-capabilities.test.ts` still passes with `route.ts` on the gated side, and **mutate its entry** — delete the `await checkOperatorCapabilityLive(` call and confirm it fails. The list does not fail on omission.
- [ ] **File the `access_proposal_merged` direction.** The issue must carry: that its recipient cannot exist until #482 lands; that `gitops` writes `"Requested by {actor}"` into the PR body (`github.go:294`, `:373`) but nothing parses it out or returns it, so the proposer is not on the wire; and that `Pulls` queries `state=open` (`review.go:112`) so a merged proposal is unreachable. Reference §8's argument for why the direction matters once the persona exists.

  `gh issue create` fails when run from inside a `bash script.sh` — the EMU error is misleading. Run it as a direct command.

---

## Spec coverage

**§8's table** — `access_proposal_open` ships (Tasks 4–5); `access_proposal_merged` is deferred with the reason recorded above and filed in Task 6.
**§8's first forced change** — per-capability filtering, Task 3.
**§8's second forced change** — the discriminated union, Task 2.
**§8's inheritance from #285** — preserved, not rebuilt: the route keeps `checkOperatorCapabilityLive`, so revoking `rotate-credentials` stops someone's proposal notifications within five minutes.
**Cutover §10** — the ticket path is tested before the union lands, Task 1.

**Not covered:** any `secrets-api` change; per-kind unread watermarks (one shared watermark, noted in Task 3); the notification kinds the prototype showed for rejected proposals, which share the merged direction's missing persona.
