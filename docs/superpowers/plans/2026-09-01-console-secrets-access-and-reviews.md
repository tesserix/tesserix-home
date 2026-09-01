# Console secrets access and reviews — Implementation Plan (phase 3b-ii)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can see who reads a secret, add and remove a reader, destroy a secret, and work through the queue of proposals those changes raise.

**Architecture:** Access and review calls added to the existing `secrets-api` client, a "Who can read this" card on the secret detail route, a destroy affordance beside it, and a two-route reviews queue (list, then one proposal with its diff). The surface stays unlisted.

**Tech Stack:** Next.js 16 App Router (React 19, server components + client forms), TypeScript, `@tesserix/web` primitives, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-console-secrets-absorption-design.md` — §5 the flow and the reject path, §6 the two stores, §9 the security properties. Authorisation is `docs/superpowers/specs/2026-09-01-secrets-console-cutover-design.md` **§4**, which is the later and more specific document wherever the two disagree.

**Visual design:** the approved prototype at
`/Users/Mahesh.Sangawar/.claude-personal/projects/-Users-Mahesh-Sangawar-personal-tesserix-new-tesserix-home/3c807e87-0b65-4d2d-832c-5889e7027eb8/tool-results/artifact-1ce7c134-1788164522-0334.html`
Translate its structure, copy and intent into console components; do not copy its markup. **§"Where the prototype and the API disagree" below overrides it in three named places, and nowhere else.**

## Scope

3a shipped the inventory (`a7c43c4`). 3b-i shipped inspect and write (`28528c3`). This is **3b-ii**, and it ships as **two pull requests** — Tasks 1–6 (access on a secret, and destroying one), then Tasks 7–11 (the reviews queue). Both stay unlisted; nothing here is user-visible until the chart cutover.

Still to come after this: **3c** — bell notifications (spec §8), which refactors `NotificationItem` into a discriminated union tickets also use. Then the chart cutover, then retirement.

**Deliberately not in scope:**

- **The prototype's `Apps` screen.** It is a read-only inversion of the grants — "an app's blast radius" — and the prototype's own closing note calls it "a view, not a second way to grant". Nothing in this phase depends on it and it needs its own route id and rail decision. File it; do not build it here.
- **Notifications** for a queued proposal. That is 3c, and this plan must leave no half-built notification behind.
- **An optional reason on a revoke** (spec §5). The spec itself puts it out of scope for the move.

---

## Where the prototype and the API disagree

The prototype is the visual authority. Three things in it cannot be built as drawn, each verified against the shipped Go source. These three resolutions win; everywhere else the prototype wins.

### 1. A non-approver cannot propose an OpenBao grant at all

The prototype draws one `Propose access` button whose outcome depends on the viewer: an approver's change applies immediately, a non-approver's queues. The routes do not work that way.

`secrets-api/internal/api/server.go:86-93` puts every route needing `rotate-credentials` in a `live` group nested inside the `platform` group. `handlers/access.go:32-35` registers `POST /api/access/grants` and `DELETE /api/access/grants/:namespace/:app` **in `live`**. `CreateGrant` calls `bao.GrantAll` and grants access immediately; the pull request it opens afterwards is a receipt. So a `platform`-only operator gets a 403 from that route. **It never queues.**

`POST /api/access/whitelist` (`handlers/whitelist.go:47`) is registered on the read group and genuinely only proposes — but merging it adds a `namespaceWhitelist` entry in `tesserix-k8s` and creates no OpenBao grant. Sending a non-approver there would be worse than refusing them: their pull request would merge and still grant nothing.

Cutover design §4 names this exactly ("A known asymmetry this creates") and rules that splitting `CreateGrant` "is a change to the product design, not to this cutover, and should be filed rather than absorbed here."

**Resolution:** the reader controls — add and remove — are offered only to an operator holding `platform` + `rotate-credentials`. A `platform`-only operator sees a sentence naming the capability they lack, in the prototype's own register, and no control. Task 11 files the split.

This is the prototype's established pattern for exactly this situation, not an invention: its Reviews card already renders `You cannot approve this. Someone holding rotate-credentials can.` as prose rather than a disabled button. Capability-conditional copy is **swapped text, never a greyed control** — that rule is the prototype's, and it holds here.

### 2. `serviceAccount` is a required field the prototype has no input for

The prototype's grant identity is one `namespace/app` string. Both write routes require three fields: `bao.AppRef` (`internal/bao/access.go:131-134`) and `whitelistRequest` (`handlers/whitelist.go:52-58`) both tag `name` and `serviceAccount` `binding:"required"`, and `gitops.App.validate` rejects anything that is not a DNS label.

In `tesserix-k8s`' live `charts/thirdparty/openbao/values.yaml` `namespaceWhitelist`, `serviceAccount` equals `name` in every entry. That is a convention, not a rule, and spec §9 requires *"Wildcard ServiceAccounts refused; isolation is per app, not per namespace"* — so a silent invisible default is the wrong move: it would write a value the operator never saw into the file that decides who can read secrets.

**Resolution:** three inputs — namespace, app name, service account — with the service account **prefilled from the app name as the operator types, and editable**. Prefilled and visible, so the common case is one field of typing and the value going into Git is always on screen.

### 3. The prototype has no delete or destroy

There is no delete button, no destroy affordance and no type-the-name confirmation anywhere in it. The only mention is prose in the GSM note. So the prototype is **silent**, not opposed, and spec §9 is the authority: *"Destroy requires typing the secret name."*

`DELETE /api/secrets/*path?destroy=true` (`handlers/secrets.go:153-176`) is one route with two behaviours: `destroy` absent or anything but the literal `"true"` calls `store.Delete` (soft, reversible via restore); `destroy=true` calls `store.Destroy` (final).

**Resolution:** build it, in the prototype's register — short declarative sentences that name the mechanism. Delete and destroy are distinct actions with distinct copy, and only destroy takes the typed name.

### A fourth divergence, of layout only

The prototype renders every proposal as one always-expanded card with its diff inline, on a single Reviews screen. It is a static mock with three proposals and no network; the API splits the data across `GET /api/reviews` (no diff) and `GET /api/reviews/:number` (`PullDetail`, with `files[].patch`). Rendering the prototype's layout means one detail request per card.

**Resolution:** a list route and a detail route, matching the API's own shape. Each list row carries what `PullRequest` provides; the diff, approvals and mergeable state live on the detail route. Everything else about the cards — the copy, the chips, the ordering, the state variants — follows the prototype.

---

## THE constraints

Carried from 3b-i and still absolute:

- **Nothing can read a value back.** No code in this plan may issue a request to display a secret value. `Store` has no `Read` method and the console's Google credential lacks `secretmanager.versions.access`. A "reveal" anywhere in this phase would be a Critical defect.
- **A GSM secret's readers are unknowable here, which is not the same as absent.** `hasReader` is `null`, never `false`. The access card is **replaced** by the IAM card, never rendered empty — spec §6 says why in as many words, and the prototype puts the reason on screen.

New to this phase:

- **The gate follows effect, not HTTP verb.** Reads and whitelist/wiring proposals take `platform`. Anything that writes OpenBao, writes a store, or merges to `tesserix-k8s` takes `platform` + `rotate-credentials`. Do not infer the tier from the method — `POST /api/access/grants` is a write and `POST /api/access/whitelist` is not.
- **`Grant.secretPrefix` must not be used for anything.** tesserix-home#476: `GrantAll` sets it without the KV mount, `Grants` — the list endpoint — sets it with. `lib/secrets.ts`'s `parseGrants` already drops it deliberately and matches on `namespace` + `app`, which both constructors set identically. Keep it dropped. A parser in this plan that starts reading `secretPrefix` reintroduces the bug the existing comment exists to prevent.

## Global Constraints

- The Zitadel **project** id is `386377618200461939`; `386377229942128837` is the Tesserix **organization**. Any fixture standing for an audience uses the project id.
- Every response is parsed and validated at the boundary, following `lib/secrets.ts`'s existing `fail`/`str`/`bool`/`num`/`optionalStr` idiom — never a cast.
- **Go zero timestamps.** `gitops.PullRequest.CreatedAt` is a `time.Time` with no `omitempty`, and `gitops/review.go:61` **discards the parse error** (`created, _ := time.Parse(...)`), so an absent or unparseable GitHub timestamp reaches the console as the literal `"0001-01-01T00:00:00Z"` — well-formed, non-empty, truthy. `lib/secrets.ts` already has `ZERO_TIME` and `optionalTimestamp` for exactly this; reuse them. Do not write a fresh optional-string check and assume it catches it.
- The surface stays **unlisted**: no sidebar entry for anything in this phase.
- Commit messages: single line, conventional-commit prefix, no signature, no `Co-Authored-By` trailer.
- Every test is **mutated before it is trusted**: make it fail for the reason it claims to guard, then restore. A test that has only ever passed has demonstrated nothing. Ask of every check: **what would make this fail?** A grep for a path string that the code never spells out cannot fail; neither can a mutation that produces a compile error instead of an assertion failure.
- **Comments must state the real reason.** The recurring defect in this codebase is a comment giving a plausible reason that is not the actual one — harmless until someone reads it while deciding whether a thing is safe to change. If you are unsure why a line is the way it is, say so in the comment rather than inventing a justification.
- Each task verifies with `pnpm --filter console test:unit`, `pnpm --filter console exec tsc --noEmit`, and — for any task touching a page — `pnpm --filter console exec next build`. **`next build` is not optional and `tsc` does not replace it**: `@tesserix/web`'s barrel carries `"use client"`, so its exports resolve to `undefined` in a server component and React fails at render, invisible to both tsc and the test suite. Render tests are the only gate on that.
- **Never `tail -N` test output** — it eats the failing test's name.

## Setup, before the first dispatch

A fresh worktree needs, in order:

```
pnpm install --frozen-lockfile
pnpm -r --filter "./packages/**" build
```

Three packages ship via gitignored `dist`, so without the second command the suite is red with ~35 phantom failures before any change is made. `npm ci` fails here — there is no `package-lock.json`.

`gh pr create` fails from a worktree with a misleading EMU error. Push from the worktree; create the PR from the main checkout with `-R`/`-B`/`-H`.

---

# PR 1 — Access on a secret, and destroying one

### Task 1: Access calls in the client

**Files:**
- Modify: `apps/console/lib/secrets.ts`, `apps/console/lib/secrets.test.ts`
- Modify: `apps/console/lib/secrets-api.ts`, `apps/console/lib/secrets-api.test.ts`

**Interfaces:**
- Consumes: `secretsRequest`, `SecretStore`, `Grant`, `parseGrants`, `encodeSecretPath`.
- Produces:
  - `interface AppRef { namespace: string; name: string; serviceAccount: string }`
  - `async function createGrant(app: AppRef, ttl?: string): Promise<void>`
  - `async function revokeGrant(namespace: string, app: string): Promise<void>`
  - `async function deleteSecret(store: SecretStore, path: string, destroy: boolean): Promise<void>`
  - `function readersFor(path: string, grants: readonly Grant[]): Grant[]` — exported from `lib/secrets.ts`

**Confirmed wire shapes** — read from the Go source, do not re-derive:

- `POST /api/access/grants`, body `{"namespace":…,"apps":[{"name":…,"serviceAccount":…}],"ttl":…}`. `ttl` is `"0"` for a grant that does not expire and has no `binding` tag, so omitting it is legal. Response is `{"grants":[…],"status":"granted"}` plus **exactly one of** `"pullRequest"` (a URL), `"proposal":"unchanged"`, or `"proposalError"` (a string).
- `DELETE /api/access/grants/:namespace/:app` → `{"namespace":…,"app":…,"status":"revoked"}`.
- `DELETE /api/secrets/*path?backend=…&destroy=true` → `{"path":…,"destroyed":bool}`. Anything other than the literal `"true"` is a soft delete.

**The response of `createGrant` is deliberately discarded**, and this is the one place in the task that needs a comment stating the real reason: its `grants[].secretPrefix` is the mount-relative form while `GET /api/access/grants` returns the mount-inclusive one (#476), so the two cannot be joined. The caller re-reads the grants list instead, which is one shape.

- [ ] **Step 1: Write the failing tests for `readersFor`**

In `apps/console/lib/secrets.test.ts`. `readersFor` is the same prefix rule `hasGrantFor` already implements privately — extract it rather than writing a second one, and have `hasGrantFor` call it, so there is one definition of "covers".

Cover: a grant on the exact path; a grant on a parent prefix; **a grant on `namespace/api` must NOT cover `namespace/api-internal`** (the trailing-slash rule `hasGrantFor`'s comment already names); multiple grants covering one path returning all of them; no grants returning `[]`.

Mutate: delete the trailing slash from the "beneath" check and confirm the `api-internal` case fails. That is the assertion doing work; the others would pass without it.

- [ ] **Step 2: Implement `readersFor`, refactor `hasGrantFor` onto it**

- [ ] **Step 3: Write the failing client tests**

In `apps/console/lib/secrets-api.test.ts`, following the existing `writeSecret` tests exactly — same fetch stub, same `__resetPlatformTokenModuleForTests()` discipline, **not** `vi.resetModules()` (it breaks `instanceof PlatformApiError`).

Assert on the **request** as much as the response, and assert against the *contract* rather than against the code that builds it:
- `createGrant` sends `POST` to `/api/access/grants` with body `{namespace, apps:[{name, serviceAccount}]}` — assert the parsed body object, not a serialised string.
- `createGrant` omits `ttl` when not given, and sends it when given.
- `revokeGrant` sends `DELETE` to `/api/access/grants/tesserix/console` and **URL-encodes each segment**.
- `deleteSecret(store, path, false)` sends `DELETE` with **no `destroy` parameter**; `deleteSecret(store, path, true)` sends `destroy=true`.
- A 403 surfaces as a `PlatformApiError` with `status === 403` — the shape the caller distinguishes "you lack the capability" from "the store refused".

Mutate at the layer that builds the request: change `deleteSecret` to always send `destroy=true` and confirm the soft-delete test fails with an assertion, not a type error.

- [ ] **Step 4: Implement the three client functions**

Each gets a doc comment naming its endpoint, its verb, **and its capability tier** — a reader deciding whether a call is safe needs to know it is in `live`.

**Verify:** `pnpm --filter console test:unit`, `pnpm --filter console exec tsc --noEmit`.

---

### Task 2: The reader list on the detail page, read-only

**Files:**
- Modify: `apps/console/app/(console)/platform/secrets/[...path]/page.tsx`, `page.test.tsx`
- Modify: `apps/console/app/(console)/platform/secrets/[...path]/secret-detail-view.tsx`
- Create: `apps/console/app/(console)/platform/secrets/[...path]/access-card.tsx`

Read-only first, and deliberately so: the card's hardest property — that a GSM secret is never rendered as an empty reader list — is a rendering decision, and getting it under test before any control exists is what stops it being an afterthought once there is a form to build.

**Interfaces:** `AccessCard({ store, path, readers, canWrite })`.

- [ ] **Step 1: Fetch the grants alongside the detail**

Add the grants read to `page.tsx`'s existing `Promise.all`, guarded the way `fetchSecretsInventory` guards it: `secrets-api` only registers `/api/access/grants` when OpenBao is configured (`server.go`'s `if d.Bao != nil`), so on a GSM-only deployment that route 404s. **Skip the call entirely when `store !== "openbao"`** — a GSM secret's readers are not knowable from it in any case, so the request would be both useless and a source of spurious errors.

- [ ] **Step 2: Write the failing render tests**

In `page.test.tsx`, following its existing harness — server component awaited and rendered, `hasCapability` **not** mocked.

The assertions that carry weight:
- An OpenBao secret with no covering grant renders `Nothing reads this secret yet.` **and** the warning chip `No app can read this`.
- An OpenBao secret with one covering grant renders `1 reader`; two render `2 readers`.
- **A GSM secret renders the IAM card and NOT the access card** — assert both directions: the IAM copy is present *and* `Nothing reads this secret yet.` is absent. Asserting only the first would pass with both cards rendered, which is the failure mode that matters.
- A GSM secret renders no reader chip at all — not `No app can read this`, not `0 readers`.

Mutate: change the store check so the access card renders for GSM, and confirm the absence assertion fails. If it does not, the assertion is not doing work.

- [ ] **Step 3: Build `access-card.tsx`**

Copy from the prototype, verbatim:
- Title `Who can read this`, sub `Each change here is a change to tesserix-k8s.` (`tesserix-k8s` in mono).
- Chip: 0 → warning, `No app can read this`; N → ok, `1 reader` / `N readers`.
- Rows: mono `namespace/app`, nothing else yet.
- Empty: `Nothing reads this secret yet.`

The IAM card, also verbatim, including its second paragraph — the prototype puts the rationale on screen deliberately and it is the clearest statement of the distinction anywhere in the product:

> Governed by **Google Cloud IAM**, not from here. This store has no whitelist in `tesserix-k8s`, so there is nothing for the console to propose.
>
> Deliberately not shown as an empty reader list — "nothing can read this" and "this tool does not manage who reads this" are different facts.

**Verify:** unit tests, `tsc --noEmit`, **and `next build`** — this task adds a component to a server-rendered page.

---

### Task 3: Server actions for grant and revoke

**Files:**
- Create: `apps/console/app/(console)/platform/secrets/[...path]/access-actions.ts`, `access-actions.test.ts`
- Modify: `apps/console/lib/auth/render-path-capabilities.test.ts`

**Interfaces:**
- `type GrantAccessResult = { ok: true } | { ok: false; message: string }`
- `async function grantAccessAction(input: { namespace: string; app: string; serviceAccount: string }): Promise<GrantAccessResult>`
- `async function revokeAccessAction(namespace: string, app: string): Promise<GrantAccessResult>`

**This action gates, and 3b-i's `actions.ts` does not — the difference is not arbitrary.** `writeSecretAction` carries a `DELIBERATE EXCEPTION` because `secrets-api` is the only authority on a write and duplicating the check bought nothing. These actions change `tesserix-k8s`, the repository governing the cluster; cutover design §4 puts approval "in application code" and says it "gets the platform API's treatment: refuse by default, no fallback that silently allows." So they gate console-side with `checkOperatorCapabilityLive`, and go in `GATED_FILES`.

Use the audited shape (`billing/catalog/actions.ts`'s `withDraftWrite`), not the thin one: **the capability check runs inside `auditedOperation`'s `operation`**, so a refusal becomes a `capability.refused` row rather than vanishing. A refused attempt to grant access to a secret is precisely the thing an audit log exists to hold.

- [ ] **Step 1: Write the failing action tests**

Mock `@/lib/secrets-api` wholesale — the action is the boundary under test. Assert whole result objects with `toEqual`.

- A `CapabilityError` returns `{ ok: false, message: <the no-permission copy> }` and the underlying error text never reaches the caller.
- A `PlatformApiError` 403 returns the same no-permission message — the server refusing and the console refusing must read identically to the operator, because to them they are the same fact.
- Any other failure degrades to a fixed message; **internal error text is replaced, never passed through**.
- The failure result carries no error instance and no `cause` — plain data only.
- On success the action calls `createGrant` with the three fields it was given, unchanged.

Mutate: return `cause.message` instead of the fixed string and confirm the leak test fails.

- [ ] **Step 2: Implement, mirroring `withDraftWrite`**

`"use server"` modules must not use `export type { Foo }` — Next emits it as a runtime binding and the whole page fails at module eval. `export type Foo = …` is safe. (`lib/server-action-type-export.guard.test.ts` enforces this.)

- [ ] **Step 3: Append `app/(console)/platform/secrets/[...path]/access-actions.ts` to `GATED_FILES`**

Then **mutate**: delete the `await checkOperatorCapabilityLive(` line and confirm `render-path-capabilities.test.ts` fails. This list is hand-curated and does not fail on omission, so proving it bites on *this* entry is the only evidence the entry is real.

**Verify:** unit tests, `tsc --noEmit`.

---

### Task 4: The add-and-remove controls

**Files:**
- Modify: `access-card.tsx`; create `access-card.test.tsx`
- Modify: `page.tsx` (pass `canWrite` through — it already computes it for the write form)

`page.tsx` already computes `canWrite` as `!requiresCapability() || (hasCapability(session?.roles,"platform") && hasCapability(session?.roles,"rotate-credentials"))`. That is the same gate these controls need. **Reuse the existing value; do not add a second capability read** — two reads of the same thing are two things that can disagree.

- [ ] **Step 1: Write the failing tests**

Render `AccessCard` directly (client component, jsdom, `.test.tsx`).

- With `canWrite`, the `Add an app` field group and the `Propose access` button render, and each reader row has a `Remove` button.
- **Without `canWrite`, neither renders**, and the refusal sentence does. Assert the absence of `Propose access` and of `Remove` explicitly — a test that only asserts the sentence is present would pass with the buttons rendered too.
- Submitting calls `grantAccessAction` once with `{namespace, app, serviceAccount}` parsed from the inputs.
- Typing an app name updates the service-account field; **editing the service account and then editing the app name does not overwrite the operator's edit.** This is the one piece of state in the card and the only place it can go wrong quietly.
- Submit is refused when any of the three fields is empty. Per the prototype, invalid input is a quiet no-op, not an error banner.

- [ ] **Step 2: Implement the footer form and the `Remove` control**

Three inputs: `Namespace`, `App`, `Service account`. Field group label `Add an app`. Primary button `Propose access`. Enter submits; the fields clear on success.

`Remove` calls `revokeAccessAction`. It is **not** a local toggle — the prototype's own note says so and it is exactly right: a revoke is a change to `tesserix-k8s` on the same route and the same gate as a grant.

The note under the card, for an operator who **holds** the capability, is the prototype's approver copy:

> **Adding or removing a reader here merges immediately**, because you hold `rotate-credentials`. Both directions are a change to `tesserix-k8s` and both are recorded — a removal is not a local toggle.

For one who does not, the prototype's non-approver copy describes a queue that cannot happen (see divergence 1). Replace it, in the same register:

> **Granting access needs `rotate-credentials`.** Both adding and removing a reader change `tesserix-k8s` immediately, so both take the credential verb. Someone holding it can make this change for you.

- [ ] **Step 3: Refresh after a successful change**

The card re-reads rather than mutating local state, for the same reason the inventory's orphan flag is derived rather than remembered: a grant can also be changed from outside this page.

**Verify:** unit tests, `tsc --noEmit`, `next build`.

---

### Task 5: Delete and destroy

**Files:**
- Create: `destroy-secret.tsx`, `destroy-secret.test.tsx`
- Modify: `access-actions.ts` (add the action), `access-actions.test.ts`, `secret-detail-view.tsx`

**Interfaces:** `async function deleteSecretAction(store: SecretStore, path: string, destroy: boolean): Promise<GrantAccessResult>`

Same gate and same audited shape as Task 3. Spec §9's *"Destroy requires typing the secret name"* is a property of this surface, and the test for it must fail if the confirmation is removed.

- [ ] **Step 1: Write the failing tests**

- The destroy control is absent without `canWrite`.
- The confirm button is disabled until the typed text **exactly equals** the secret's full path. Assert a near-miss is refused — a trailing space, and a correct final segment with the wrong prefix. A test that only checks the empty string passes against a confirmation that accepts any non-empty input.
- Confirming calls `deleteSecretAction` with `destroy: true`.
- **Delete does not require the typed name**, and calls the action with `destroy: false`.
- The action's `destroy` argument reaches `deleteSecret` unchanged.

Mutate: change the comparison to `startsWith` and confirm the near-miss test fails.

- [ ] **Step 2: Implement**

Two distinct actions with distinct copy, in the prototype's register — short sentences naming the mechanism. Delete is reversible (`restoreSecretVersion` already exists in the client for the restore control, which is not this task). Destroy is not, and its copy must say which.

`Destroy` is the only place in this phase using a destructive style; the prototype uses the plain secondary style for `Remove` and `Reject` and that stays.

**Verify:** unit tests, `tsc --noEmit`, `next build`.

---

### Task 6: PR 1 review pass

- [ ] Run `pnpm --filter console test:unit`, `pnpm --filter console exec tsc --noEmit`, `pnpm --filter console exec next build`. Read the whole test output; do not pipe it through `tail`.
- [ ] Re-read every comment added in Tasks 1–5 against the code it sits above. The recurring defect here is a comment stating a plausible reason that is not the real one. Three specific claims to check, because each is easy to state wrongly: why `createGrant`'s response is discarded (#476, not "we don't need it"); why the grants call is skipped for GSM (the route 404s without OpenBao *and* the answer would be meaningless, not "GSM has no readers"); why `access-actions.ts` gates when `actions.ts` does not (it changes `tesserix-k8s`, not "writes should be gated").
- [ ] Confirm no code path anywhere in the diff requests a secret value.
- [ ] Push from the worktree; open the PR from the main checkout with `-R`/`-B`/`-H`.

---

# PR 2 — The reviews queue

### Task 7: Reviews in the client

**Files:**
- Modify: `apps/console/lib/secrets.ts`, `secrets.test.ts`, `secrets-api.ts`, `secrets-api.test.ts`

**Interfaces:**
- `interface Proposal { number: number; title: string; url: string; branch: string; author: string; createdAt?: string; targets: string[] }`
- `interface ProposalDetail extends Proposal { mergeableState: string; approvals: string[]; files: ChangedFile[] }`
- `interface ChangedFile { filename: string; additions: number; deletions: number; patch: string }`
- `parseProposals`, `parseProposalDetail`
- `fetchProposals()`, `fetchProposal(number)`, `approveProposal(number)`, `mergeProposal(number)`, `rejectProposal(number, reason?)`

**Confirmed wire shapes:**
- `GET /api/reviews` → `{"pulls":[…]}`. `GET /api/reviews/:number` → `PullDetail` **bare, not wrapped** (`handlers/reviews.go:67`).
- All three verbs are `POST /api/reviews/:number/{approve,merge,reject}` in the `live` group. `merge` returns `{"number":…,"sha":…,"status":"merged"}`.
- `reject` takes an optional `{"reason":…}`; the handler ignores a bind error, so an empty body is legal.
- **When no review repository is configured the handler returns 503**, not 404 (`reviews.go:120-126`). The page must read that as "not configured", the same calm state the inventory gives a 501 — not as an error.

- [ ] **Step 1: Write the failing parser tests**

The one that carries weight: **`createdAt` of `"0001-01-01T00:00:00Z"` parses to `undefined`.** This is reachable, not hypothetical — `gitops/review.go:61` discards `time.Parse`'s error, so any GitHub timestamp it cannot parse becomes the zero time and serialises as that literal string. Use the existing `optionalTimestamp`; do not write a new check.

Mutate: swap `optionalTimestamp` for `optionalStr` and confirm the test fails with an assertion. If it compiles and passes, the test is asserting the wrong thing.

Also cover: a bare (unwrapped) detail response parsing; a malformed entry throwing rather than defaulting; and **`files` and `targets` arriving as JSON `null`**, which both can — they are plain `[]T` fields declared with `var`, so an empty upstream response leaves them nil and `encoding/json` writes `null`, not `[]`. `approvals` is built with `make`, so it is always an array; do not assume the three behave alike.

- [ ] **Step 2: Implement the parsers and the five client calls**

**Verify:** unit tests, `tsc --noEmit`.

---

### Task 8: The route ids

**Files:**
- Modify: `packages/console-core/src/routes.ts`, `packages/console-core/src/routes.console.test.ts`

- [ ] Add `"platform.secretsReviews": { mobile: "/platform/secrets/reviews", capability: "platform" }`.

Capability `platform`, not `rotate-credentials`, and the comment must say why rather than leaving it to be re-derived: cutover design §4's *"Why entry is not the verb"* — if the verb were needed to look, everyone who can see the queue could also merge, and the two-tier design silently degrades to one tier. Entry must be a surface for the queue to mean anything.

Unlisted, like `platform.secrets`, and for the same reason — no rail entry until the chart cutover. Do **not** restate `platform.secrets`' long comment; point at it.

- [ ] Add it to `routes.console.test.ts`'s `missing` array (it has no `web` predecessor).
- [ ] The detail route `/platform/secrets/reviews/[number]` gets **no** route id — detail routes are not registered in this console, matching `secrets/[...path]`.

**Verify:** `pnpm test`, `tsc --noEmit`.

---

### Task 9: The queue list

**Files:**
- Create: `app/(console)/platform/secrets/reviews/page.tsx`, `page.test.tsx`, `proposals-table.tsx`

- [ ] **Step 1: Write the failing render tests**

- Rows render number, title, author and relative time; a proposal with no `createdAt` renders without a date rather than "1 Jan year 1" or a crash.
- Empty renders `Nothing is waiting for approval.`
- A **503** renders the "not configured" state, calm — not an error. Assert on the shipped copy, exported as a constant the way `SECRETS_UNAVAILABLE_TITLE` is, so the test pins the string that ships.
- A `platform`-only operator still sees the list. Reading the queue is the surface, not the verb.

- [ ] **Step 2: Implement**

H1 `Reviews`, lede `Proposals waiting on someone who can approve them. Approving merges the change; ArgoCD syncs it from there.` Each row links to the detail route and carries the GitHub `url` as a secondary link out.

Server component → import from `@/components/kit/surface-state`, **never** `@/components/kit/states`. `states.tsx` carries a load-bearing `"use client"`; calling `resolveState` through it throws at render while tsc, `next build` and jsdom tests all pass. Both existing secrets pages carry this comment at the import site; carry it here too.

**Verify:** unit tests, `tsc --noEmit`, `next build`.

---

### Task 10: One proposal, and acting on it

**Files:**
- Create: `app/(console)/platform/secrets/reviews/[number]/page.tsx`, `page.test.tsx`, `proposal-view.tsx`, `proposal-view.test.tsx`
- Create: `app/(console)/platform/secrets/reviews/[number]/actions.ts`, `actions.test.ts`
- Modify: `apps/console/lib/auth/render-path-capabilities.test.ts` (**both** lists)

- [ ] **Step 1: The page and its gate**

Render-path gate in `page.tsx` — the synchronous `getCurrentSession` + `hasCapability` shape, guarded by `!requiresCapability()`. **Never `checkOperatorCapabilityLive` on the render path**: that is a DB read plus a periodic IdP round trip behind every render.

Append `app/(console)/platform/secrets/reviews/[number]/page.tsx` to `RENDER_PATH_FILES` and `.../actions.ts` to `GATED_FILES`. Then **mutate both entries** — the page's `hasCapability` call and the action's `checkOperatorCapabilityLive` call — and confirm each makes `render-path-capabilities.test.ts` fail. Both lists are hand-curated and neither fails on omission, so an unmutated entry is unproven.

- [ ] **Step 2: Write the failing render tests**

- The diff renders from `files[].patch`, in a container that scrolls horizontally on its own so the page body never does.
- **Non-`ASCII` and long patches do not break the layout**, and the patch is rendered as text — never as markup.
- A `platform`-only operator sees `You cannot approve this. Someone holding rotate-credentials can.` and **no** `Approve & merge` and **no** `Reject` button. Assert both absences.
- An operator holding both sees `Approve & merge` (primary) then `Reject` (secondary).
- A merged proposal shows `Approved by <who>`; a rejected one shows `Rejected by <who> — nothing changed`. Neither offers a control.

- [ ] **Step 3: The actions**

Audited, gated on `platform` + `rotate-credentials`, same shape as Task 3. `Approve & merge` is `approve` then `merge`; **if the merge fails after the approve succeeded, say so** — the approval stands on GitHub and a message claiming nothing happened would be false.

Reject sends no reason (the prototype collects none, and spec §5 keeps the revoke reason out of scope). Send the request with an empty body, which the handler accepts.

**Verify:** unit tests, `tsc --noEmit`, `next build`.

---

### Task 11: File what this phase deliberately did not fix, and review

- [ ] **File the `CreateGrant` split** against `tesserix/tesserix-home`. It is the reason divergence 1 exists. The issue should carry: the two routes and their tiers with file:line; that `POST /api/access/whitelist` merging grants nothing in OpenBao, so redirecting a non-approver there is worse than refusing them; cutover design §4's ruling that this be filed rather than absorbed; and that the console now renders a refusal sentence which becomes wrong the moment the split lands.

  `gh issue create` fails when run from inside a `bash script.sh` — the EMU error it prints is misleading. Run it as a direct command.

- [ ] **File the `Apps` screen** — the prototype's read-only blast-radius view, with its own note that it is "a view, not a second way to grant".

- [ ] Full run: `pnpm --filter console test:unit`, `tsc --noEmit`, `next build`. Read the whole output.
- [ ] Re-read every comment added in PR 2. The claims most likely to be stated wrongly: why the reviews route id takes `platform` rather than the verb (§4's "entry is not the verb", not "reading is safe"); why 503 is a calm state (no review repository configured, not "the service is down"); why the detail route has no route id (detail routes are not registered here, not "it is unlisted").
- [ ] Push from the worktree; open the PR from the main checkout.

---

## Spec coverage

**§5** — the reject path and the derived orphan flag shipping together: reject is Task 10, and the flag it feeds already ships (3a). The *"grant an app access to this?"* affordance left as a seam by 3b-i lands as Task 4's card, reached from the create success state.
**§6** — the two stores are a filter, not a tab: the access card is *replaced* for GSM (Task 2), never emptied.
**§9** — destroy requires typing the secret name (Task 5); no endpoint returns a value, and nothing in this plan asks for one.
**Cutover §4** — the gate follows effect: Tasks 3, 5 and 10 take the verb; Tasks 2 and 9 take the surface.

**Not covered here:** notifications (3c); the `Apps` screen and the `CreateGrant` split (filed in Task 11); the restore control (`restoreSecretVersion` exists in the client but has no caller and gains none here).
