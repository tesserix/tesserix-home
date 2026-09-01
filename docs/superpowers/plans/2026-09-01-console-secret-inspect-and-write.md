# Console secret inspect and write — Implementation Plan (phase 3b-i)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can open a secret to see its shape and version history, and can write a new version — creating a secret or rotating one.

**Architecture:** Two additions to the existing `secrets-api` client (describe, versions, write), a secret detail route under the inventory, and a write form whose value field is write-only by construction. The surface stays unlisted.

**Tech Stack:** Next.js 16 App Router (React 19, server components + a client form), TypeScript, `@tesserix/web` primitives, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-console-secrets-absorption-design.md` — §5 the flow, §6 the two stores, **§7 writing a value**. Read §7 in full before Task 4; this plan implements it and does not restate it.

**Visual design:** the approved prototype at
`/Users/Mahesh.Sangawar/.claude-personal/projects/-Users-Mahesh-Sangawar-personal-tesserix-new-tesserix-home/3c807e87-0b65-4d2d-832c-5889e7027eb8/tool-results/artifact-1ce7c134-1788164522-0334.html`
Its **Create secret** section is the authority for the write form. Translate its structure and intent into console components; do not copy its markup.

## Scope

Phase 3a shipped the inventory (merged, `a7c43c4`). This is **3b-i**. Still to come:

- **3b-ii** — grants, whitelist proposals, and the reviews queue with approve/merge/reject.
- **3c** — bell notifications (spec §8), which refactors `NotificationItem` into a discriminated union tickets also use.

Do not implement either here. In particular, the success state's *"grant an app access to this?"* affordance (spec §5 step 2) is 3b-ii's; Task 6 leaves a deliberate seam for it, nothing more.

## THE constraint: nothing can read a value back

`secrets-api` has **no endpoint that returns a secret's value**. Its `Store` interface has no `Read` method, and spec §6 says why in as many words: *"so no handler can leak one."* The console's Google credential holds `secretManagerWriteBlind` — create, update, destroy, metadata — but **not** `secretmanager.versions.access`.

So:

- **"Reveal" shows what the operator typed in this browser session. It never fetches.** If any code in this plan issues a request to display a value, that is a Critical defect regardless of whether an endpoint exists to serve it — it encodes an expectation that one might.
- **"Copy" copies from the same in-memory string.**
- The form's own copy must say the true thing: **this is the only moment the value can be retrieved.**

Spec §7 records a rejected alternative — a "do not show it to me" mode — and the reasoning is worth carrying: it reads as a stronger guarantee than it is, because the operator can always look, and the guarantee that matters is about every moment *after* creation, which the IAM role and the absent `Store.Read` already provide.

## Global Constraints

- The Zitadel **project** id is `386377618200461939`; `386377229942128837` is the Tesserix **organization**, not a project. Any fixture standing for an audience uses the project id.
- Reads are gated on `platform`. **Writes are gated on `platform` + `rotate-credentials`** — `PUT /api/secrets/*path` and `POST /api/secret-versions/*path` are in `secrets-api`'s `live` tier. A `platform`-only operator must be able to inspect and must not be able to write.
- Every response is parsed and validated at the boundary, following `lib/secrets.ts`'s existing validators — not a cast.
- The surface stays **unlisted**: no sidebar entry. The detail route is reached from the inventory.
- Commit messages: single line, conventional-commit prefix, no signature, no Co-Authored-By trailer.
- Every test is **mutated before it is trusted**: make it fail, then restore.
- Each task verifies with `pnpm vitest run`, `pnpm tsc --noEmit`, and — for tasks touching a page — `pnpm next build`. `tsc` is not optional: phase 3a shipped a typecheck error through two reviews because it was only run at the end.

---

### Task 1: Describe and versions in the client

**Files:**
- Modify: `apps/console/lib/secrets.ts`, `apps/console/lib/secrets.test.ts`
- Modify: `apps/console/lib/secrets-api.ts`, `apps/console/lib/secrets-api.test.ts`

**Interfaces:**
- Consumes: `secretsRequest`, `SecretStore`.
- Produces:
  - `interface SecretDetail { ref: unknown; path: string; version: number; keys: string[]; createdAt?: string; updatedAt?: string }`
  - `interface SecretVersion { version: number; createdAt?: string; destroyed: boolean; deleted: boolean }`
  - `function parseSecretDetail(json: unknown): SecretDetail`
  - `function parseSecretVersions(json: unknown): SecretVersion[]`
  - `async function fetchSecretDetail(store: SecretStore, path: string): Promise<SecretDetail>`
  - `async function fetchSecretVersions(store: SecretStore, path: string): Promise<SecretVersion[]>`

**Confirmed wire shapes** — these are read from the Go source, do not re-derive:

`GET /api/secrets/*path?backend=…` returns the `secrets.Secret` struct **bare, not wrapped**:
```json
{"ref":{…},"path":"homechef/homechef-api/db","version":3,"keys":["password"],"createdAt":"…","updatedAt":"…"}
```
`GET /api/secret-versions/*path?backend=…` returns `{"path":…,"versions":[{"version":2,"createdAt":"…","destroyed":false,"deleted":true}]}`.

**`keys` is a list of key NAMES, never values.** Nothing in either response carries a value; if you find yourself writing a type with a `value` field, stop.

- [ ] **Step 1: Write the failing parser tests**

In `apps/console/lib/secrets.test.ts`, follow the existing `parseSecretList` / `parseGrants` idiom exactly. Cover:

```ts
it("reads a secret's shape", () => {
  expect(parseSecretDetail({ path: "a/b/c", version: 3, keys: ["password"] }))
    .toMatchObject({ path: "a/b/c", version: 3, keys: ["password"] });
});

it("rejects a detail with a non-numeric version", () => {
  expect(() => parseSecretDetail({ path: "a/b/c", version: "3", keys: [] })).toThrow();
});

// A response carrying a value would mean the service grew an endpoint that
// returns one. Parse it out rather than passing it along: the console has no
// legitimate use for it, and a type that can hold one invites a UI that shows it.
it("ignores any value-shaped field rather than surfacing it", () => {
  const parsed = parseSecretDetail({ path: "a/b", version: 1, keys: ["k"], data: { k: "hunter2" } }) as Record<string, unknown>;
  expect(parsed.data).toBeUndefined();
  expect(JSON.stringify(parsed)).not.toContain("hunter2");
});

it("reads versions, preserving destroyed and deleted", () => {
  expect(parseSecretVersions({ versions: [{ version: 2, destroyed: false, deleted: true }] }))
    .toEqual([{ version: 2, destroyed: false, deleted: true, createdAt: undefined }]);
});

it("rejects a versions response that is not a list", () => {
  expect(() => parseSecretVersions({ versions: "nope" })).toThrow();
});
```

- [ ] **Step 2: RED**

Run: `cd apps/console && pnpm vitest run lib/secrets.test.ts`
Expected: FAIL — `parseSecretDetail` is not exported.

- [ ] **Step 3: Implement the parsers**

Real validators that throw. Build the returned object **field by field from known keys** — do not spread the input. That is what makes the third test pass, and it is the reason to prefer construction over spreading here.

- [ ] **Step 4: Add the two fetchers**

Both take `(store, path)` and go through `secretsRequest`. Encode the path segment; `secrets-api` matches `/api/secrets/*path`, so the leading slash belongs in the URL, and the mount-relative path from the inventory must not gain one.

Add a test asserting the request URL for `("openbao", "homechef/api/db")` is exactly `/api/secrets/homechef/api/db?backend=openbao` — path shape has already bitten this codebase once, in the walk.

- [ ] **Step 5: GREEN, then mutate**

| mutation | must fail |
|---|---|
| spread the input in `parseSecretDetail` instead of building it | "ignores any value-shaped field" |
| drop the `version` type check | "rejects a detail with a non-numeric version" |
| build the URL without the backend query | the URL-shape test |

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/secrets.ts apps/console/lib/secrets.test.ts apps/console/lib/secrets-api.ts apps/console/lib/secrets-api.test.ts
git commit -m "feat(console): read a secret's shape and version history"
```

---

### Task 2: The write and restore calls

**Files:** as Task 1, plus their tests.

**Interfaces:**
- Produces:
  - `async function writeSecret(store: SecretStore, path: string, data: Record<string, string>, ifVersion?: number): Promise<{ path: string; version: number; backend: string }>`
  - `async function restoreSecretVersion(store: SecretStore, path: string, version: number): Promise<void>`

**Confirmed shapes:** `PUT /api/secrets/*path` takes `{"data": {"key": "value"}, "ifVersion": 3}` and returns `{"path":…,"version":…,"backend":…}`. `ifVersion` is optional.

- [ ] **Step 1: Understand `ifVersion` before you use it**

It is optimistic concurrency: the write succeeds only if the stored version still matches. Read `secrets-api/internal/api/handlers/secrets.go`'s `Write` and the store's implementation to see what it does when they disagree, and what status comes back.

**Send it whenever the form knew a current version** — that is, on a rotate. Omitting it turns "rotate this secret" into "overwrite whatever is there now", so two operators rotating the same credential silently produce one surviving value with no indication the other happened.

Do **not** send it when creating a secret that does not exist yet.

- [ ] **Step 2: Write the failing tests**

- `writeSecret` PUTs to the right URL with `{data}` in the body
- when `ifVersion` is supplied it appears in the body; when omitted the key is absent entirely — **not** `null` or `0`, either of which the server may read as a real version
- a conflict response surfaces as a `PlatformApiError` carrying the upstream status, so the caller can tell a stale write from a permission failure
- `restoreSecretVersion` POSTs to `/api/secret-versions/*path`

- [ ] **Steps 3-5: RED, implement, GREEN, mutate**

| mutation | must fail |
|---|---|
| always include `ifVersion`, defaulting to 0 | the omitted-key test |
| flatten the conflict status to 500 | the conflict test |

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(console): write a secret version, with optimistic concurrency"
```

---

### Task 3: The detail route

**Files:**
- Create: `apps/console/app/(console)/platform/secrets/[...path]/page.tsx`
- Create: `apps/console/app/(console)/platform/secrets/[...path]/page.test.tsx`
- Modify: `apps/console/app/(console)/platform/secrets/secrets-table.tsx` (link the rows)

**Interfaces:**
- Consumes: `fetchSecretDetail`, `fetchSecretVersions`.

- [ ] **Step 1: Decide how the store reaches the route, and write it down**

A path alone does not identify a secret — the same path could exist in both stores. The store must travel with it. A search param (`?store=openbao`) is the obvious choice; a catch-all segment is another.

Pick one, and **write a comment saying why**, including what happens when the parameter is absent or is not a known store. Fail closed: an unknown store is a 404-style "not found" state, not a default to OpenBao. Defaulting would show one store's secret under another's identity.

- [ ] **Step 2: Write the failing render tests**

- the detail renders path, current version, and key **names**
- **no test fixture anywhere in this task contains a secret value**, because nothing in the response can carry one
- version history renders, and a destroyed version is visibly distinguished from a merely deleted one — they are different facts and the UI must not collapse them
- an absent or unknown `store` parameter renders the not-found state
- a `PlatformApiError` 404 renders not-found rather than throwing

- [ ] **Steps 3-4: RED, implement, GREEN**

Follow the inventory page's shape — server component, `SurfaceState`, the same error handling. Link rows from `secrets-table.tsx` to the detail route.

- [ ] **Step 5: Mutate**

| mutation | must fail |
|---|---|
| default an unknown `store` to `"openbao"` | the unknown-store test |
| render `deleted` and `destroyed` with the same label | the version-history test |

- [ ] **Step 6: Commit**

---

### Task 4: The write form — read §7 first

**Files:**
- Create: `apps/console/app/(console)/platform/secrets/[...path]/write-secret-form.tsx` (client component)
- Create: its test file

**Before writing anything, read spec §7 in full and the prototype's Create secret section.**

- [ ] **Step 1: The value field is write-only by construction**

- hidden by default; a **Reveal** toggle shows it; a **Copy** control copies it
- both operate on **React state — the string the operator typed or generated in this session.** Neither issues a request. There is no endpoint to request, and writing code that assumes one might exist is the defect this task most needs to avoid.
- a **Generate** action produces **32 random bytes** via `crypto.getRandomValues`, not `Math.random`
- the form states plainly that this is the only moment the value can be retrieved

Write a comment on the reveal handler recording *why* it reads state rather than fetching — that the store has no read path at all, by design, so there is nothing to fetch even if a future reader wanted to add it.

- [ ] **Step 2: Write the failing tests**

- Generate populates the field, and twice produces different values
- Reveal toggles visibility **without any network call** — assert on a `fetch` spy that it was never called
- Copy writes the current value to the clipboard
- submitting calls `writeSecret` with the typed key/value pair
- on a rotate (a secret that already exists) `ifVersion` is passed; on a create it is not
- **the success state does not display the value**

The reveal test's `fetch` assertion is the important one: it is what stops a later "improvement" from turning reveal into a read.

- [ ] **Steps 3-5: RED, implement, GREEN, mutate**

| mutation | must fail |
|---|---|
| make Reveal fetch from `/api/secrets/...` before showing | the no-network reveal test |
| use `Math.random` in Generate | the two-generates-differ test (run it enough times to be deterministic, or assert on the crypto call) |
| show the value in the success state | the success-state test |

- [ ] **Step 6: Commit**

---

### Task 5: Wire the form into the detail page, gated on the verb

**Files:** modify Task 3's page and its test.

- [ ] **Step 1: The gate**

Writing requires `platform` + `rotate-credentials`. A `platform`-only operator must see the secret and **must not see a write affordance that will fail**.

Read how the console learns the current operator's capabilities — start from `apps/console/lib/auth/operator-token-store.ts`'s `readCapabilities` and follow it to whatever a page uses. **Do not invent a mechanism**; if there is no server-side way to ask, say so in your report and stop rather than guessing.

The API refuses regardless — `secrets-api` gates the route — so this is about not offering an action that cannot succeed, never about security. Say that in a comment, so nobody later mistakes the hidden button for the control.

- [ ] **Step 2-5: tests, implement, mutate**

- a `rotate-credentials` holder sees the form
- a `platform`-only operator does not, and the page still renders the detail
- mutation: show the form unconditionally → the second test fails

- [ ] **Step 6: Commit**

---

### Task 6: Whole-app verification

**Files:** none.

- [ ] **Step 1**

```bash
cd apps/console
pnpm vitest run
pnpm tsc --noEmit
pnpm next build
```

`next build` is not covered by the other two: this phase adds a **client** component alongside server ones, which is exactly where a server-only import crosses into a browser bundle.

- [ ] **Step 2: Confirm no value can reach the browser**

```bash
grep -rn "value" apps/console/app/\(console\)/platform/secrets/ --include=*.tsx | grep -iv "inputvalue\|e.target.value\|value=\{" | head -20
```

Read every hit and confirm none reads a value from a response. This is a read-and-judge step, not a pass/fail grep — say in your report what you looked at and what you concluded.

- [ ] **Step 3: Confirm still unlisted**

```bash
grep -rn "platform/secrets\|platform\.secrets" apps/console/components packages/console-core/src/nav.ts
```

Expected: no nav hit. (The ⌘K palette reaches it via route id — that is known and accepted, recorded in `routes.ts`.)

---

## Self-review

**Spec coverage.** §7's hidden-by-default value, reveal, copy, Generate-32-bytes and the only-moment copy → Task 4. §6's "no handler can leak one" → the write-only construction in Task 4 and the value-stripping parser in Task 1. §5's create-completes-on-its-own → Task 4's success state, which touches Git not at all. The optional *"grant an app access?"* next step is deliberately **not** here; it belongs with 3b-ii's proposal flow.

**Not covered:** grants, whitelist proposals, the reviews queue (3b-ii); notifications (3c); delete and destroy — deliberately left to 3b-ii so that destroy, which is irreversible, lands beside the access flow that gives it context rather than as a button added in passing.

**Type consistency.** `SecretDetail`, `SecretVersion` and the two fetchers are defined in Task 1 and consumed unchanged in Tasks 3–5. `writeSecret`'s `ifVersion` is optional throughout and is never defaulted to a number.
