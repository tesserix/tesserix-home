# Catalog Authoring — Plan 3: The Operator Surface and Cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an operator a surface to see the catalog, edit a draft, review what a publish will do to Stripe, and understand what happened when one half-fails — then cut over from `billing-bootstrap`.

**Architecture:** Server components read through Plan 1's publication-aware repo; a client editor mutates a draft; the publish screen renders Plan 2's typed plan and routes guard breaches through the kit's existing `DestructiveConfirmDialog`. Cutover is a sequenced runbook, not a code change.

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19, `@tesserix/web`, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-27-console-catalog-authoring-design.md`

## Global Constraints

- **Plans 1 and 2 must be complete.**
- **The Zitadel role `publish-catalog` must exist and be assigned before this merges.** Otherwise publishing is dead for every operator, with a `CapabilityError` that names no cause.
- **v1 is test mode only.** Live publishing is refused by Plan 2's mode guard; the surface must say why rather than hiding the control.
- Server/client split: a client component importing a value from a module with server ancestry drags `pg` into the browser bundle. `tsc` and vitest both pass; `next build` fails. Import types with `import type`; for values, use a module with no server ancestry.
- Rebuild `console-core` before app tests. Scope vitest with `pnpm --filter console exec vitest run <path>`.
- Reuse `components/kit/`: `DestructiveConfirmDialog`, `ConsoleDataTable`, `ConsolePageHeader`, `SurfaceStateView`. Promoting a second copy of a shared control is what Ruling 17 exists to prevent.
- TDD throughout.

---

## File Structure

| file | responsibility |
|---|---|
| `packages/platform-auth/src/capabilities.ts` | add the `publish-catalog` risk verb |
| `apps/console/app/(console)/platform/billing/catalog/page.tsx` | server: read catalog + publication + parity status per mode |
| `.../catalog/catalog-view.tsx` | client: the table, the mode switch |
| `.../catalog/draft-editor.tsx` | client: edit amounts on a draft |
| `.../catalog/publish-view.tsx` | client: the plan, guards, confirmation |
| `.../catalog/actions.ts` | server actions: draft, plan, publish |
| `docs/superpowers/runbooks/2026-catalog-cutover.md` | the sequenced cutover |

---

### Task 1: The `publish-catalog` risk verb

**Files:**
- Modify: `packages/platform-auth/src/capabilities.ts`
- Test: `packages/platform-auth/src/capabilities.test.ts`

**Interfaces:**
- Produces: `"publish-catalog"` as a member of `Capability` and of `RISK_CAPABILITIES`.

- [ ] **Step 1: Write the failing test**

```ts
it("treats publish-catalog as a risk verb, not a surface", () => {
  // Surfaces say WHERE, verbs say WHAT. Holding `billing` shows subscription
  // state; changing what mark8ly charges the world is a different question,
  // and gating publish on `billing` alone would silently upgrade every
  // existing billing grant without one of them being re-reviewed.
  expect(RISK_CAPABILITIES).toContain("publish-catalog");
});

it("does not admit a publish on the billing surface alone", () => {
  expect(hasCapability(["billing"], "publish-catalog")).toBe(false);
  expect(hasCapability(["billing", "publish-catalog"], "publish-catalog")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tesserix/platform-auth exec vitest run src/capabilities`
Expected: FAIL — `"publish-catalog"` is not assignable to `Capability`.

- [ ] **Step 3: Implement**

Add to the capability array beside `hard-delete`, and to `RISK_CAPABILITIES`, with a comment recording the Zitadel precondition:

```ts
  /**
   * Publish the plan catalog to Stripe — create, replace or archive Prices.
   *
   * NOT `rotate-credentials`, which already covers "payment-gateway keys,
   * Stripe settings": holding a credential verb should not imply the ability
   * to change what customers are charged. Different blast radius, different
   * grant.
   *
   * DEPLOY PRECONDITION: these strings are a contract with Zitadel. The role
   * must exist on the Platform Console project AND be assigned before this
   * ships, or publishing is dead for every operator — including whoever
   * deployed it — with a CapabilityError that names no cause.
   */
  "publish-catalog",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tesserix/platform-auth exec vitest run src/capabilities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/platform-auth/src/capabilities.ts packages/platform-auth/src/capabilities.test.ts
git commit -m "feat(platform-auth): publish-catalog as a risk verb"
```

---

### Task 2: The catalog surface

**Files:**
- Create: `apps/console/app/(console)/platform/billing/catalog/page.tsx`, `catalog-view.tsx`, `page.test.tsx`, `catalog-view.render.test.tsx`

**Interfaces:**
- Consumes: `readCatalogAmounts(mode)`, `readLivePublication(mode)`, `readWindowStatus(days)` (Plans 1 and #378).

- [ ] **Step 1: Write the failing test**

```ts
it("renders the catalog for the mode in the URL, not a default", () => {
  // A mode is a location, not component state: a link to live must survive a
  // refresh and be shareable, like every other console index surface.
  renderView({ mode: "live", ... });
  expect(screen.getByRole("link", { name: /test/i })).toHaveAttribute("href", expect.stringContaining("mode=test"));
});

it("says live has never been bootstrapped, rather than showing an empty table", () => {
  // `not_bootstrapped` is not an error and not an empty catalogue. An operator
  // seeing a blank page files a bug.
  renderView({ mode: "live", publication: null, rows: [] });
  expect(screen.getByText(/has never been published/i)).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

it("groups prices by plan and shows each currency's amount", () => {
  renderView({ mode: "test", rows: FULL_CATALOG });
  expect(screen.getByRole("heading", { name: "pro" })).toBeInTheDocument();
  expect(screen.getAllByRole("row").length).toBeGreaterThan(42);
});

it("shows who published the current revision and when", () => {
  // Nothing else tells a second operator a publish happened. published_by and
  // published_at exist in the schema; rendering them is what makes them useful.
  renderView({ mode: "test", publication: { publishedBy: "mahesh", publishedAt: "2026-08-27T10:00:00Z" } });
  expect(screen.getByText(/mahesh/)).toBeInTheDocument();
});

it("shows the parity window status for the mode", () => {
  renderView({ mode: "test", window: { satisfied: false, cleanDays: 3, requiredDays: 7 } });
  expect(screen.getByText(/3 of 7/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/billing/catalog"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`page.tsx` is a server component: reads the mode from `searchParams`, calls the repo, and passes plain data down. `catalog-view.tsx` carries `"use client"` and renders. Gate the page on `checkOperatorCapability(session, "billing")` — viewing is the surface capability; publishing needs the verb (Task 4).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/billing/catalog"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/(console)/platform/billing/catalog"
git commit -m "feat(console): the plan catalog surface, per Stripe mode"
```

---

### Task 3: Editing a draft

**Files:**
- Create: `.../catalog/draft-editor.tsx`, `draft-editor.render.test.tsx`, `.../catalog/actions.ts`

**Interfaces:**
- Consumes: `createDraftFrom`, `discardDraft`, `currentDraft` (Plan 2 Task 1).
- Produces: server actions `startDraftAction(mode)`, `setAmountAction(revisionId, lookupKey, currency, minor)`, `discardDraftAction(revisionId)`.

- [ ] **Step 1: Write the failing test**

```ts
it("warns at the point of edit when an amount moves more than 25%", () => {
  // Guards in the plan builder are LATE — the wrong number entered here is
  // cheapest to catch here. The plan-level guard still runs; this is the
  // early one.
  editAmount("mark8ly_pro_monthly_developed_v1", "usd", 1070); // was 10700
  expect(screen.getByRole("status")).toHaveTextContent(/10x lower than the published/i);
});

it("refuses a non-integer or negative amount before it reaches the server", () => {
  editAmount("k", "usd", -1);
  expect(screen.getByRole("alert")).toHaveTextContent(/whole number of minor units/i);
});

it("shows the published value beside the draft value", () => {
  // An operator editing needs to see what they are changing FROM.
  renderEditor({ published: 10_700, draft: 11_900 });
  expect(screen.getByText("10700")).toBeInTheDocument();
  expect(screen.getByDisplayValue("11900")).toBeInTheDocument();
});

it("marks an in-place currency edit as one that reprices existing subscribers", () => {
  // The safety property is the OPPOSITE of intuition: replacements cannot
  // touch existing subscribers, in-place currency_options changes do, at
  // their next renewal.
  renderEditor({ currency: "gbp" }); // non-baseline -> in place
  expect(screen.getByText(/existing subscribers.*next renewal/i)).toBeInTheDocument();
});

it("does not claim to know WHICH subscribers", () => {
  // The read client performs no Subscription reads and its key must not be
  // widened for this. The rule is stated; the population is not.
  renderEditor({ currency: "gbp" });
  expect(screen.queryByText(/\d+ subscribers/)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/billing/catalog/draft-editor"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

The editor is a client component; server actions live in `actions.ts` and are the only things touching the repo. Editing requires `billing`; it does not require `publish-catalog` — a draft changes nothing in Stripe.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/billing/catalog/draft-editor"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/(console)/platform/billing/catalog"
git commit -m "feat(console): edit a catalog draft, with the repricing rule stated at the point of edit"
```

---

### Task 4: The publish screen

**Files:**
- Create: `.../catalog/publish-view.tsx`, `publish-view.render.test.tsx`
- Modify: `.../catalog/actions.ts`

**Interfaces:**
- Consumes: `buildPublishPlan`, `checkGuards`, `executePublish`, `promotePublication` (Plan 2).
- Produces: `planPublishAction(revisionId, mode)`, `publishAction(revisionId, mode, confirmations)`.

- [ ] **Step 1: Write the failing test**

```ts
it("leads with what Stripe will DO, not how many rows changed", () => {
  // "6 prices changed" hides the distinction that matters: replacement
  // retires a Price object and mints a new one.
  renderPlan({ counts: { update_currency_options: 3, replace_price: 2, archive_price: 1 } });
  expect(screen.getByText(/3 updated in place/i)).toBeInTheDocument();
  expect(screen.getByText(/2 replaced/i)).toBeInTheDocument();
});

it("separates intended changes from drift corrections", () => {
  renderPlan({ counts: { intended: 1, drift: 39 } });
  expect(screen.getByText(/1 intended/i)).toBeInTheDocument();
  expect(screen.getByText(/39 correcting drift/i)).toBeInTheDocument();
});

it("requires the mode to be typed before publishing", () => {
  // v1 is test-only, but the control is built for live from the start: live's
  // first publish is a 42-price bootstrap, the largest action this tool takes.
  renderPlan({ mode: "test" });
  const confirm = screen.getByRole("button", { name: /publish/i });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/type the mode/i), { target: { value: "test" } });
  expect(confirm).toBeEnabled();
});

it("refuses a live publish and says why", () => {
  renderPlan({ mode: "live" });
  expect(screen.getByRole("alert")).toHaveTextContent(/live publishing is not enabled/i);
  expect(screen.queryByRole("button", { name: /publish/i })).toBeDisabled();
});

it("blocks entirely on a refusal, and only warns on a confirmation breach", () => {
  renderPlan({ guards: { refused: [{ rule: "currency-coverage", detail: "gbp missing from pro monthly" }] } });
  expect(screen.getByRole("button", { name: /publish/i })).toBeDisabled();
  expect(screen.getByText(/gbp missing/i)).toBeInTheDocument();
});

it("names the plan in the confirmation dialog", () => {
  // DestructiveConfirmDialog carries the aria-describedby association a
  // screen-reader operator needs to learn why a confirm button is unreachable.
  renderPlan({ guards: { requiresConfirmation: [{ rule: "magnitude" }] } });
  expect(screen.getByRole("dialog")).toHaveAccessibleDescription(/25%/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/billing/catalog/publish-view"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`publishAction` calls `checkOperatorCapability(session, "publish-catalog")` **in addition to** `billing`, then `executePublish`, then `promotePublication` only if the outcome is `succeeded`. Reuse `DestructiveConfirmDialog` with `statusId` pointed at the typed-mode gate's live status paragraph.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/billing/catalog/publish-view"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/(console)/platform/billing/catalog"
git commit -m "feat(console): the publish screen, showing Stripe's real operations"
```

---

### Task 5: What the operator sees when it half-fails

**Files:**
- Create: `.../catalog/publish-outcome.tsx`, `publish-outcome.render.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it("shows which operations landed and which did not, immediately", () => {
  // Not "logged, detectable later". A publish that errors with a spinner and
  // no detail leaves the operator guessing whether Stripe is half-changed.
  renderOutcome({ operations: [
    { sequence: 1, kind: "update_currency_options", lookupKey: "a", status: "succeeded" },
    { sequence: 2, kind: "replace_price", lookupKey: "b", status: "failed", error: "rate limited" },
  ]});
  expect(screen.getByText(/rate limited/)).toBeInTheDocument();
  expect(screen.getAllByRole("row")).toHaveLength(3);
});

it("surfaces orphans found by the automatic post-failure check", () => {
  // The parity check CANNOT see these — it skips prices with a null
  // lookup_key, and a transferred-away price has one. It would report clean.
  renderOutcome({ orphans: [{ priceId: "price_old", lookupKey: "b" }] });
  expect(screen.getByText(/price_old/)).toBeInTheDocument();
  expect(screen.getByText(/still active in Stripe/i)).toBeInTheDocument();
});

it("offers re-planning rather than retrying the same plan", () => {
  // Recovery is re-observe-and-re-plan. Retrying a stale plan risks acting on
  // a captured price id that is no longer what it was.
  renderOutcome({ outcome: "failed" });
  expect(screen.getByRole("link", { name: /re-plan/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
});

it("says the publication was NOT promoted when the attempt failed", () => {
  renderOutcome({ outcome: "failed", promoted: false });
  expect(screen.getByText(/still published/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/billing/catalog/publish-outcome"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

The action returns the operation rows and runs `findOrphans(mode)` automatically on a failed attempt rather than waiting for the nightly run.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/billing/catalog/publish-outcome"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Full suite and build**

Run: `pnpm --filter console exec vitest run`, then `pnpm --filter console build`
Expected: PASS; `next build` succeeds. **This is the step that catches a client component importing a server-ancestry value** — tsc and vitest will not.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(console): the publish outcome surface, including orphans"
```

---

### Task 6: The cutover runbook

**Files:**
- Create: `docs/superpowers/runbooks/2026-catalog-cutover.md`

This task writes a document, not code. It is a task rather than a note because the sequence is the risky part and it must exist before anyone starts.

- [ ] **Step 1: Write the runbook**

Contents, in order, each with its own verification:

1. **`0034` and `0035` and `0036` applied to prod**, verified by querying `schema_migrations`.
2. **Zitadel role `publish-catalog` created and assigned**, verified by an operator loading the publish screen and seeing an enabled control.
3. **The three `[X]` experiments** run against test mode, answers recorded in the spec.
4. **Wipe test mode** — Stripe Dashboard → test data → delete all. Verified: `prices?limit=1` returns empty.
5. **Bootstrap test from the console** — the first publish, a 3-product / 42-price plan. Verified: the parity check reports `clean` for test.
6. **Soak** — leave the nightly check running. Verified: 7 consecutive `clean` days for test in `readWindowStatus`.
7. **Bootstrap live**, once someone decides live should exist. Same path, mode guard lifted deliberately.
8. **Retire `billing-bootstrap`** — a mark8ly change, only after live has converged through the console once, and only after the `catalog.go` inventory (spec §10) says what else reads it.

**Rollback at each step:** steps 1–3 are additive and reversible. Step 4 is **not reversible** — but test mode holds nothing of value, verified 2026-08-27 (three canceled `stripelive_task8_*` subscriptions at $9.99, no `mark8ly_*` subscription). Steps 5–7 are re-runnable: convergence means a second run produces an empty plan.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/2026-catalog-cutover.md
git commit -m "docs(runbook): the catalog cutover sequence"
```

---

## What Plan 3 deliberately does NOT do

- Live publishing. The mode guard refuses it; lifting that is a decision, not a task.
- Rollback of a publish. Re-publishing a previous revision is expressible but is **not undo** — a replaced Price stays archived and re-publishing mints another. The UI says so rather than implying an undo that does not exist.
- Anything about `pricing-data.ts`. The marketing site remains a second author; #329 covers it and should be filed before this ships.
- Retiring `billing-bootstrap` or touching `catalog.go` — a different repo, and `catalog.go` has three runtime readers.

## Definition of done

- An operator with `billing` can see the catalog per mode; only one with `publish-catalog` as well can publish.
- The publish screen shows Stripe's real operations, and separates intent from drift.
- A half-failed publish is legible within seconds, with orphans surfaced automatically.
- The cutover runbook exists, with a verification and a rollback position for every step.
