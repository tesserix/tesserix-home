# Console create-secret — Implementation Plan (phase 3b-iii)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can create a secret that does not yet exist — pick a store, name a path, name a key, supply or generate a value, and have it written — reaching that form from the inventory rather than from a URL nobody can guess.

**Spec:** `docs/superpowers/specs/2026-08-31-console-secrets-absorption-design.md` — **§5** is the flow (create completes on its own; the success state then offers the optional grant), **§6** the two stores, **§7** the value field. No new spec: §5 already specifies this.

**Visual authority:** the approved prototype's **Create secret** section —
`/Users/Mahesh.Sangawar/.claude-personal/projects/-Users-Mahesh-Sangawar-personal-tesserix-new-tesserix-home/3c807e87-0b65-4d2d-832c-5889e7027eb8/tool-results/artifact-1ce7c134-1788164522-0334.html`
(screen `#screen-create`, and the `#go-create` button under the secrets list). Translate its structure and intent into console components; do not copy its markup. Two deliberate departures from it, both recorded in Task 4 and Task 5.

## The gap this closes

The write form already has both modes: it renders **"Create secret"** with no current version and **"Rotate secret"** with one (`write-secret-form.tsx`, `asRotateVersion`). **Nothing can reach the create mode.** `[...path]/page.tsx` turns a 404 from `fetchSecretDetail` into `notFound()`, and the inventory has no "New secret" action — so the only reachable path is a *rotate* of a secret that already exists.

It slipped because 3b-i scoped the form as "reached from the inventory", and every task, review and test in it operated on an existing secret. Nothing asked "what if the path is new?" — a gap *between* tasks, invisible to any per-task review. Do not treat that as trivia: this plan's Task 8 exists to make the same question askable next time.

## What already exists — do NOT rebuild

Verified in the source at `517fc82`:

- **`writeSecret` (`lib/secrets-api.ts:560`) already handles create.** `ifVersion` is omitted on a create and sent only on a rotate. Read its doc comment before touching it — it is explicit that *omitted ≡ 0 ≡ no check* on the wire, and that "fixing" that is a mistake.
- **`writeSecretAction` (`[...path]/actions.ts`) is the boundary a client form calls across**, and it is reused unchanged. **Correction to the brief that commissioned this plan: it is NOT capability-gated and NOT audited.** It calls neither `checkOperatorCapability` nor `checkOperatorCapabilityLive`, deliberately, and carries a `DELIBERATE EXCEPTION` marker that `lib/auth/render-path-capabilities.test.ts` greps for by string. The gate is secrets-api's own — `PUT /api/secrets/*path` sits in its `Live` tier requiring `rotate-credentials`, on the *operator's own* Zitadel token. Reusing this action therefore adds **no** new `GATED_FILES` entry; a new action that duplicated it would.
- **The value field** — hidden by default, reveal, copy (with the secure-context and rejected-promise guards), Generate (32 bytes via `crypto.getRandomValues`), and §7's unconditional "this is the only moment" hint. Task 1 extracts it; nothing re-implements it.
- **The backend already creates.** `gcpsm.ensureSecret` (`gcpsm.go:314`) POSTs a new GSM secret when the GET returns `ErrNotFound`; OpenBao KV v2 writes create implicitly. `PUT /api/secrets/*path` on a new path works today.
- **The access card ships.** 3b-ii landed (#480, #481), so §5 step 2's *"grant an app access to this?"* seam now leads to a real surface — the new secret's own detail page — rather than to nothing. That is a change from 3b-i, where the seam was left deliberately dead.

## What a valid path actually is — read from the Go source, not invented

`secrets-api/internal/secrets/path.go`, `internal/gcpsm/gcpsm.go`. **Do not paraphrase these from this plan into code without reading them.**

`CleanSecretPath` (both stores):
- trims; rejects `> 512` characters; rejects any `\`
- splits on `/`; **empty segments are dropped**, not rejected
- rejects a segment that is exactly `.` or `..`
- rejects a segment containing `%` (percent-encoding is how traversal gets smuggled past a naive split)
- rejects a control character (`< 0x20`, or `0x7f`)
- rejects an empty result

`ParseSecretRef` (**required by OpenBao `Write`**, `bao/kv.go:105`):
- `CleanSecretPath` first, then **at least 3 segments**: `<namespace>/<app>/<name>`, where `name` is every remaining segment rejoined (so a name may itself contain `/`)
- segments 0 and 1 must both match `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` — a Kubernetes DNS label. This is the isolation boundary: an app's OpenBao policy is scoped to `kv/data/<namespace>/<app>/*`, so a secret naming neither cannot be read by anything.

**GSM (`gcpsm.Write`) additionally:** every segment must match `^[a-zA-Z0-9_-]+$` (`segmentPattern`), because the path is flattened into one Secret Manager id joined by `--` (`pathSeparator`).

**GSM create needs all three segments too, and for a non-obvious reason.** `gcpsm.Write` routes a path with an empty namespace or app to `writeFlat`, and `writeFlat` **refuses to create** — it GETs the secret and returns *"does not exist; create a secret as `<namespace>/<app>/<name>`"* on `ErrNotFound`. Only the `ensureSecret` branch creates. So "≥ 3 segments" is a real precondition of creation on **both** stores, not an OpenBao quirk generalised.

## Global constraints

- **Client-side path validation is UX, not a control.** It exists so an operator learns *which* rule they broke before a round trip, not because the API is trusted to be lenient. Say that in the code. The API is the control, and it re-validates every one of these rules.
- Reads are gated on `platform`. **Writes need `platform` + `rotate-credentials`.** The new page's check is a **render-path** check: synchronous `getCurrentSession` + `hasCapability(session?.roles, …)`, never `checkOperatorCapabilityLive`. Add every new page with such a check to `RENDER_PATH_FILES` in `lib/auth/render-path-capabilities.test.ts` — that list is hand-curated and **does not fail on omission**, so Task 7 mutates the entry to prove it bites.
- A server component imports state helpers from `@/components/kit/surface-state`, **never** `@/components/kit/states`. The latter is `"use client"`; its exports resolve to `undefined` in a server component and React fails at render — invisible to `tsc` and to `next build`.
- Every response parsed and validated at the boundary, following `lib/secrets.ts`'s validators — not a cast.
- Commit messages: single line, conventional-commit prefix, no signature, no `Co-Authored-By` trailer.
- **Every test is mutated before it is trusted.** Each task below names the required mutation. A check nobody watched fail is not a check — about ten such were found in the preceding session (two dead `assertNever` guards, a route capability nothing pinned, a `queryByLabelText` that cannot match a `fieldset`, a 404 branch for a status the handler never returns). For each assertion you write, answer: *what would make this fail?*
- Each task verifies with `pnpm vitest run`, `pnpm tsc --noEmit`, and — for any task touching a page — `pnpm next build`. `next build` passing still does not prove a page renders; the `surface-state` rule above is what covers that.
- Setup, once, before Task 1: `pnpm install --frozen-lockfile`, then `pnpm -r --filter "./packages/**" build`. Skipping the second gives a phantom ~35-test failure.

---

### Task 1: Extract the value field so one implementation serves both forms

**Files:**
- Create: `apps/console/components/secrets/secret-value-field.tsx`
- Create: `apps/console/components/secrets/secret-value-field.test.tsx`
- Modify: `apps/console/app/(console)/platform/secrets/[...path]/write-secret-form.tsx`
- Modify: `apps/console/app/(console)/platform/secrets/[...path]/write-secret-form.test.tsx`

**Why extract rather than copy.** The value field is not layout — it is four correctness properties: reveal reads React state and **never fetches** (there is no endpoint to fetch from; `Store` has no `Read` method); copy guards both the missing-`navigator.clipboard` case *and* the rejected promise; Generate uses `crypto.getRandomValues`, never `Math.random`; and the hint says §7's true sentence unconditionally. A second copy of that in a create form is a second place for each to regress, and only one of them would have the tests.

**Interfaces:**
- Produces `SecretValueField`, a controlled component:
  - `value: string`, `onChange(next: string): void`, `disabled?: boolean`, `id?: string` (default `"secret-value"`, so two instances on one page could differ; the hint's id derives from it)
- Move `generateSecretValue`, `handleReveal`, `handleCopy` and the `copyError` callout into it. The generated value reaches the parent through `onChange`, so the parent stays the single owner of the value.
- `write-secret-form.tsx` keeps `value`/`setValue` and renders `<SecretValueField>`; its own reveal/copy/generate state and handlers are deleted, not left dead.

**Carry the comments across, and check each one still names its real reason.** Comments that state a plausible reason that is not the real one are this codebase's top recurring defect. In particular: the "no `name` attribute" comment is about the **form**, not the field — it belongs where the `<form>` is, so leave it in `write-secret-form.tsx` and make sure the new field's own file does not acquire a garbled version of it. The `helperText` note ("`@tesserix/web`'s `Input` declares it, the shipped bundle never reads it") is about the field and moves with it.

**Verification:**
- [ ] `secret-value-field.test.tsx` covers: reveal toggles `type` between `password` and `text` and **issues no network call** (stub `fetch` and assert it was never called); copy with `navigator.clipboard` deleted surfaces the manual-copy message rather than throwing; copy with a rejecting `writeText` surfaces the failure message; Generate produces a value that changes on a second click and is not empty.
- [ ] **Mutation, required:** replace `crypto.getRandomValues` with a constant and confirm the "changes on a second click" assertion fails. Then restore. If it does not fail, the assertion is decorative — fix it before continuing.
- [ ] **Mutation, required:** delete the `navigator.clipboard?.writeText` guard and confirm the missing-clipboard test fails.
- [ ] `write-secret-form.test.tsx` still passes unchanged except for identifiers that genuinely moved. **If a test in it had to be weakened to keep passing, stop and report** — that means the extraction changed behaviour.
- [ ] `pnpm vitest run`, `pnpm tsc --noEmit`

---

### Task 2: A path validator that mirrors the Go rules

**Files:**
- Create: `apps/console/lib/secret-path.ts`
- Create: `apps/console/lib/secret-path.test.ts`

**Read first:** `secrets-api/internal/secrets/path.go` in full, and `SecretID`/`secretID`/`segmentPattern` in `secrets-api/internal/gcpsm/gcpsm.go`. Encode what those do, not what the section above summarises.

**Interfaces:**
- `interface SecretPathProblem { readonly message: string }` — or return `string | null`; keep it a value, not a thrown error, because the form renders it inline while typing.
- `function validateSecretPathForCreate(path: string, store: SecretStore): { ok: true; cleaned: string } | { ok: false; message: string }`

**Behaviour:** clean first (trim, drop empty segments, reject `\`, `%`, control chars, `.`/`..`, `> 512` chars, empty result), then require ≥ 3 segments and check segments 0 and 1 against the DNS-label pattern, then — **only for `gcpsm`** — check every segment against `^[a-zA-Z0-9_-]+$`.

Each rejection returns a message naming the rule *and the segment that broke it*, in the console's voice — an operator who typed `Mark8ly/stripe/webhook` must be told the namespace has to be lowercase, not handed "invalid path".

**The comment this module must carry:** why it duplicates rules the API already enforces (fail early with the real reason; the API remains the control), and that it is a **mirror of a specific file** — name `secrets-api/internal/secrets/path.go` so the next person changing one knows to change the other.

**Verification:**
- [ ] Table-driven tests, one case per rule, **both directions** — a rejecting input and an accepting near-miss for each. `a/b/c` accepted; `a/b` rejected for arity; `A/b/c` rejected for the namespace pattern; `a/B/c` rejected for the app pattern; `a/b/c%2f` rejected; `a/../c` rejected; `a//b/c` accepted and cleaned to `a/b/c`; `a/b/c/d` accepted (`name` may contain `/`); a 513-character path rejected; `a/b/c.d` accepted for `openbao` and **rejected for `gcpsm`**; `a/b/c` accepted for both.
- [ ] **Mutation, required:** the store-dependent case is the one that most easily rots into a test that cannot fail. Change the `gcpsm` branch to run for both stores and confirm the `openbao` `a/b/c.d` case fails; change it to run for neither and confirm the `gcpsm` case fails. Both directions, then restore.
- [ ] **Cross-check against Go, required:** run the Go tests for `internal/secrets` and read `path_test.go` for a case this table does not have. Report any rule the Go source enforces that this module does not.
- [ ] `pnpm vitest run`, `pnpm tsc --noEmit`

---

### Task 3: Ask the API which stores this deployment can write to

**Files:**
- Modify: `apps/console/lib/secrets-api.ts`, `apps/console/lib/secrets-api.test.ts`

**Interfaces:**
- `export interface SecretStoreChoices { readonly enabled: SecretStore[]; readonly preferred: SecretStore | null }`
- `export async function fetchSecretStores(): Promise<SecretStoreChoices>`

`/api/backends` returns `{backends: string[], default?: string}`. `parseBackendNames` already exists and deliberately ignores `default` — its doc comment says why ("the inventory walk needs every enabled backend, not the one a single-store picker would default to"). **This task is that single-store picker.** Extend the parser to also read `default`, keep `fetchSecretsInventory`'s behaviour byte-identical, and **update that comment** — leaving it would make it false, which is exactly the defect class this codebase keeps hitting.

Filter through `isKnownStore`, same as the inventory. `preferred` is `null` when `default` is absent or is not an enabled known store; the caller decides what to do with that, this function does not invent one.

**Verification:**
- [ ] Tests: both stores enabled with a `default`; one store enabled; `default` naming a store not in `backends` → `preferred` is `null`; `default` absent → `preferred` is `null`; an unknown third backend is filtered out of `enabled` and never becomes `preferred`; a malformed body rejects.
- [ ] **Mutation, required:** make `preferred` fall back to `enabled[0]` when `default` is absent, and confirm the "`default` absent → null" test fails.
- [ ] `pnpm vitest run`, `pnpm tsc --noEmit`

---

### Task 4: The create form

**Files:**
- Create: `apps/console/app/(console)/platform/secrets/new/create-secret-form.tsx`
- Create: `apps/console/app/(console)/platform/secrets/new/create-secret-form.test.tsx`

A `"use client"` component. Fields, in the prototype's order: **store**, **path**, **key name**, **value** (`SecretValueField` from Task 1), then **Create secret**.

**Departure from the prototype, deliberate: it has no store picker.** Its copy says *"This writes a version to OpenBao"*, because it was drawn before §6 settled that the console manages two stores. Production holds 591 GSM secrets against 11 OpenBao ones — a create form that can only reach OpenBao would be the smaller half of the surface. So: a store control, populated from Task 3. When only one store is enabled, render it as **static text naming the store**, not a one-option select that pretends there is a choice.

**Departure from the prototype, deliberate: its `Path` placeholder is `kv/data/mark8ly/stripe`.** That is OpenBao's *physical* KV path. Every path this console sends is **mount-relative** (`fetchSecretDetail`, `writeSecret`, `Grant.SecretPrefix` since #485). Use a mount-relative example — `mark8ly/stripe/webhook` — and label the field so the shape `<namespace>/<app>/<name>` is visible before the operator gets it wrong.

**Behaviour:**
- Path validated with Task 2 on submit, and shown inline. Validate against **the currently selected store**, and re-validate when the store changes — a path that is fine for OpenBao can be invalid for GSM, and a stale "valid" from before the switch is a lie the operator acts on.
- Key name required and trimmed; value required. Reuse `write-secret-form.tsx`'s existing messages verbatim where the situation is identical, so two forms do not describe the same failure two ways.
- Submit calls `writeSecretAction(store, cleanedPath, { [key]: value }, undefined)` — **`ifVersion` omitted**, which is what makes it a create. Import the action from `../[...path]/actions`; do not add a second `"use server"` module (see "What already exists").
- **Refuse to overwrite.** Before writing, call a new `secretExistsAction` (Task 5) for the chosen store and cleaned path. If it exists, do not write: show *"A secret already exists at this path"* with a link to its detail page, where the write is a rotate with the concurrency check the create path deliberately has none of. **Why this is not over-engineering:** a create sends no `ifVersion`, which is *"no check requested"* at the store — so an unlucky path collision silently appends a version to somebody else's live secret and tells the operator they created one. The check leaves a TOCTOU window that no API call available here can close; say so in the comment rather than implying the guard is airtight.
- Success state, per §5 and the prototype's `#create-done`: *"Secret created."*, the path, the version, **a link to the new secret** — and §5 step 2's seam, *"Grant an app access to this?"*, which now leads somewhere real: the secret's detail page carries 3b-ii's access card. **For a `gcpsm` secret the seam must not be offered** — §6: GSM readers are IAM bindings this console cannot propose against, and `AccessCard` already says so. Offering a grant that cannot exist would be a second thing this surface claims and cannot back.
- The success copy says **created**, never "rotated" — reachable only when nothing existed at that path.

**Verification:**
- [ ] Tests with `writeSecretAction` and `secretExistsAction` stubbed: a happy create calls the action with `ifVersion` **`undefined`** (assert the argument, not just that it was called); an invalid path never calls either action and shows the validator's message; changing the store re-runs validation; an existing path shows the "already exists" state and **never calls `writeSecretAction`**; the failure message from a rejected action is rendered; the success state links to the detail page with the right `?store=`; the success state offers the grant seam for `openbao` and **not** for `gcpsm`.
- [ ] **Mutation, required:** change the submit to pass `1` as `ifVersion` and confirm the happy-path assertion fails. This is the single most important assertion in the plan — a create that sends an `ifVersion` is a create that 409s against an empty path, or worse, silently behaves like a rotate.
- [ ] **Mutation, required:** delete the `secretExistsAction` guard and confirm the "never calls `writeSecretAction`" test fails.
- [ ] **Mutation, required:** render the grant seam unconditionally and confirm the `gcpsm` test fails. (An `expect(queryBy…).toBeNull()` that was never watched fail is the exact shape of the dead assertions found last session.)
- [ ] `pnpm vitest run`, `pnpm tsc --noEmit`

---

### Task 5: The existence check as a server action

**Files:**
- Create: `apps/console/app/(console)/platform/secrets/new/actions.ts`
- Create: `apps/console/app/(console)/platform/secrets/new/actions.test.ts`

`export async function secretExistsAction(store, path): Promise<{ ok: true; exists: boolean } | { ok: false; message: string }>` — wraps `fetchSecretDetail`; a `PlatformApiError` with status 404 means **`exists: false`**, any other failure is `ok: false` and the form must **not** treat "we could not tell" as "it is free". That distinction is the whole point: defaulting an unknown to `false` here would reinstate the silent overwrite the guard exists to prevent.

**Capability check: none, and say why in the file.** This is a read, gated by secrets-api on `platform` on the operator's own token, and the write it precedes is gated there too. But this file is a `"use server"` module that is *not* in `GATED_FILES`, which is the same shape the linter-of-record (`render-path-capabilities.test.ts`) treats as suspicious — so the reason has to be written beside it, as `[...path]/actions.ts` and `auth/logout/route.ts` both do. Follow the form of the existing exception; do not copy its `DELIBERATE EXCEPTION` string, which Task 7's test pins to that one file.

**Verification:**
- [ ] Tests: a resolving `fetchSecretDetail` → `exists: true`; a 404 → `exists: false`; a 500 → `ok: false`; a non-`PlatformApiError` rejection → `ok: false`.
- [ ] **Mutation, required:** make the non-404 branch return `{ok: true, exists: false}` and confirm the 500 test fails.
- [ ] `pnpm vitest run`, `pnpm tsc --noEmit`

---

### Task 6: The page, and the way in

**Files:**
- Create: `apps/console/app/(console)/platform/secrets/new/page.tsx`
- Create: `apps/console/app/(console)/platform/secrets/new/page.test.tsx`
- Modify: `apps/console/app/(console)/platform/secrets/page.tsx`, `apps/console/app/(console)/platform/secrets/page.test.tsx`
- Modify: `packages/console-core/src/routes.ts`, `packages/console-core/src/routes.test.ts`

**The page** (`/platform/secrets/new`), a server component:
- `fetchSecretStores()` (Task 3), caught not thrown — a 501 here means `SECRETS_API_ORIGIN` is unset, which is the inventory's calm "not configured" state, not an error. Reuse `SECRETS_UNAVAILABLE_TITLE`/`SECRETS_UNAVAILABLE_MESSAGE` and `secretsReadError` from `secrets/page.tsx` by **importing them**, not by restating the strings.
- Render-path gate: `getCurrentSession` + `hasCapability(session?.roles, "platform")` **and** `"rotate-credentials"`, guarded by `requiresCapability()`, exactly as `[...path]/page.tsx` does. Without both, render a refusal state rather than the form — and carry that page's comment about *why* this is UX and not the control.
- Breadcrumbs back to Secrets; `ConsolePageHeader` with §5's lede: this writes a version, it does not touch Git, and it grants nothing access.

**Routing note this page must carry as a comment.** `new` is a static segment, so Next resolves `/platform/secrets/new` here and **never** to `[...path]`. That shadows exactly one thing: a Google Secret Manager secret whose entire id is the single segment `new` (GSM flat secrets created outside this console have no namespace or app — `gcpsm.secretRef`). OpenBao paths cannot collide, because a describe needs ≥ 3 segments. Accepted knowingly: `/…/new` is the ordinary shape for a create route and the collision needs a real secret literally named `new`. Write the trade-off down; a future reader finding an unreachable secret should find the reason here, not rediscover it.

**The way in:** a **New secret** action in the inventory's `ConsolePageHeader` (`actions` slot) linking to `/platform/secrets/new`. This is the entry point whose absence is the whole bug — the prototype puts the button under the list, the console puts page actions in the header, and the header is the console's convention. Show it only when the operator holds `platform` + `rotate-credentials`, which makes `secrets/page.tsx` a render-path file too (Task 7).

**routes.ts:** add `"platform.newSecret": { mobile: "/platform/secrets/new", capability: "platform" }`. `capability: "platform"`, not `rotate-credentials`, deliberately: `ROUTES` feeds the ⌘K palette, and that file's own comment requires the palette gate to be **at least as wide as** the real gate or it misleads by omission — the same reasoning the two existing secrets routes carry. **No nav entry**: the rail lists surfaces, not create actions, and #486 has just settled what belongs in Governance.

**Verification:**
- [ ] `page.test.tsx`: renders the form for a fully-capable session; renders the refusal for a `platform`-only session; renders the 501 copy when `fetchSecretStores` rejects with a 501; renders the error state on any other rejection.
- [ ] `secrets/page.test.tsx`: the New secret action is present for a capable session and **absent** for a `platform`-only one.
- [ ] **Mutation, required:** drop `rotate-credentials` from the page's gate (leave only `platform`) and confirm **both** the page's refusal test and the inventory's absence test fail. If either stays green it is not testing the gate.
- [ ] **Mutation, required:** point the header link at `/platform/secrets` and confirm the entry-point test fails.
- [ ] `pnpm vitest run`, `pnpm tsc --noEmit`, **`pnpm next build`**

---

### Task 7: Pin the new gates in the two hand-curated lists

**Files:**
- Modify: `apps/console/lib/auth/render-path-capabilities.test.ts`

Add to `RENDER_PATH_FILES`:
- `app/(console)/platform/secrets/new/page.tsx`
- `app/(console)/platform/secrets/page.tsx`

`GATED_FILES` gains **nothing**: Task 4 reuses `[...path]/actions.ts`, already covered by its own asserted exception, and Task 5's read action is not a write gate. State that in the commit message so a reviewer does not read the omission as the miss it superficially resembles.

**This list does not fail on omission** — that is written in its own doc comment, and it is why this task is separate rather than folded into Task 6.

**Verification:**
- [ ] **Mutation, required, both directions.** (1) Remove the new `secrets/new/page.tsx` entry and confirm the suite still passes — proving the list is *not* self-maintaining and this task was necessary. (2) Restore it, then delete the `hasCapability(session?.roles,` call from `secrets/new/page.tsx` and confirm the suite now **fails**. Only the second proves the entry bites. Restore both.
- [ ] `pnpm vitest run`

---

### Task 8: Close the gap that produced this gap

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-console-secret-inspect-and-write.md` (a short "what this phase did not reach" note), or add the note to this plan's tail — one place, not both.

The create mode existed and was unreachable for a week because every task in 3b-i operated on an existing secret and no task owned the question *"how is this first reached?"*. Record that as a plan-level check, not a code comment: **a plan that adds a mode must name the route that reaches it.** One paragraph. Do not turn this into a process document.

**Verification:**
- [ ] The note names the specific failure and the specific check, and does not restate this plan.

---

## Spec coverage

§5's *create completes on its own, and touches Git not at all* → Tasks 4 and 6 (the page's lede, the success copy, no proposal anywhere in the flow). §5 step 2's optional *"grant an app access to this?"* → Task 4's success seam, now leading to 3b-ii's real access card, and suppressed for GSM per §6. §6's two-stores-are-a-filter-not-a-tab → Task 3's store control, populated from the API rather than hardcoded. §7's value field → Task 1, moved rather than rewritten.

**Not covered:** creating more than one key in a single write (the API takes a map; this form writes one pair, as the prototype does — a multi-key create is a separate change with its own UI question); the whitelist proposal itself, which 3b-ii already ships and this flow only links to; and pagination of the 602-row inventory, which is a real and separate defect.

## Type consistency

`SecretStore` comes from `lib/secrets.ts` throughout. `validateSecretPathForCreate` returns a discriminated union, never throws. `writeSecretAction`'s signature is unchanged, and its fourth argument stays `undefined` on every call from this flow.
