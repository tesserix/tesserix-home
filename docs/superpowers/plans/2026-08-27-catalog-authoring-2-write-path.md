# Catalog Authoring — Plan 2: The Write Path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the console publish a catalog revision to Stripe — creating and editing products and prices — safely, resumably, and with an independent check that it did what it promised.

**Architecture:** A draft revision is diffed three ways (published ancestor · draft · observed Stripe) into a typed plan of Stripe operations. Guards refuse implausible plans. An executor writes each operation to a log *before* calling Stripe, aborts if the observation moved, and can be re-run to completion. Orphan detection covers the one failure the parity check structurally cannot see.

**Tech Stack:** TypeScript, Next.js 16, Postgres (pglite for tests), vitest, `stripe` v22.

**Spec:** `docs/superpowers/specs/2026-08-27-console-catalog-authoring-design.md`

## Global Constraints

- **Plan 1 must be complete.** This plan consumes `readCatalogAmounts(mode)`, `readLivePublication(mode)`, `SourcePolicy`/`toStripeUnitAmount`, and the widened comparator.
- **Migrations applied to production BEFORE the PR merges.** This plan's migration is `0036`.
- **A Zitadel role `publish-catalog` must exist AND be assigned before merge.** `capabilities.ts` strings are a contract with Zitadel; shipping the code first makes publishing dead for every operator, with a `CapabilityError` that names no cause.
- **Test mode is wiped before this plan's Task 7 runs.** Stripe's Dashboard test-data reset. After it the console holds 42 prices and Stripe holds none, so the first publish is a real bootstrap.
- **Every amount sent to Stripe passes through `toStripeUnitAmount`.** Skipping it sends every VND price 100× wrong — the same defect found in the comparator on 2026-08-27.
- pnpm workspace; `npm ci` FAILS. Rebuild `console-core` before app tests. Scope vitest with `pnpm --filter console exec vitest run <path>`.
- `tsc` is not a build; run `next build`.
- TDD throughout. Comment register: why, and what breaks otherwise.

---

## File Structure

| file | responsibility |
|---|---|
| `apps/web/db/migrations/0036_publish_operations.sql` | the operation log and publish attempts |
| `apps/console/lib/billing/mark8ly/stripe-write.ts` | the ONLY module that can write to Stripe |
| `apps/console/lib/billing/publish-plan.ts` | three-way diff → typed operations (pure) |
| `apps/console/lib/billing/publish-guards.ts` | magnitude, breadth, coverage, mode (pure) |
| `apps/console/lib/billing/publish-executor.ts` | write-ahead, fingerprint, idempotency, resume |
| `apps/console/lib/billing/orphans.ts` | archived-but-still-active detection |
| `apps/console/lib/db/publish-repo.ts` | draft lifecycle, attempts, operations, promote |

---

### Task 1: Draft lifecycle

**Files:**
- Modify: `apps/console/lib/db/publish-repo.ts` (create)
- Test: `apps/console/lib/db/publish-repo.integration.test.ts`

**Interfaces:**
- Consumes: `readLivePublication(mode)` (Plan 1).
- Produces: `createDraftFrom(mode, createdBy): Promise<string>`, `discardDraft(revisionId): Promise<void>`, `currentDraft(): Promise<{ id: string; basedOn: string | null } | null>`.

- [ ] **Step 1: Write the failing test**

```ts
it("copies the mode's published revision into a new draft", async () => {
  const draft = await createDraftFrom("test", "operator@tesserix");
  const rows = await amountsFor(draft);
  expect(rows).toHaveLength(78);
});

it("records what the draft was based on, so the plan can be three-way", async () => {
  const published = await readLivePublication("test");
  const draft = await createDraftFrom("test", "operator@tesserix");
  expect((await currentDraft())?.basedOn).toBe(published!.revisionId);
});

it("creates the revision and its rows in ONE transaction", async () => {
  // A revision row with no prices would diff as "archive everything".
  await expect(createDraftFromWithFailureAfterRevisionRow("test")).rejects.toThrow();
  expect(await countRevisions()).toBe(1); // the baseline only
});

it("discards a draft and its amounts together", async () => {
  const draft = await createDraftFrom("test", "op");
  await discardDraft(draft);
  expect(await countPricesFor(draft)).toBe(0);
  expect(await countOrphanAmounts()).toBe(0); // ON DELETE CASCADE from 0032
});

it("refuses to discard a revision that has been published", async () => {
  const published = (await readLivePublication("test"))!.revisionId;
  await expect(discardDraft(published)).rejects.toThrow(/violates foreign key/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/db/publish-repo`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export async function createDraftFrom(mode: StripeMode, createdBy: string): Promise<string> {
  return runTesserixTx(async (client) => {
    const live = await readLivePublicationTx(client, mode);
    if (live === null) {
      // Bootstrapping a mode that has never been published starts from the
      // OTHER mode's catalog, or from nothing. Refusing here is deliberate:
      // silently producing an empty draft would diff as "create everything"
      // against a mode that may already hold prices.
      throw new Error(`createDraftFrom: ${mode} has no published revision to base a draft on`);
    }
    const { rows: [rev] } = await client.query<{ id: string }>(
      `INSERT INTO plan_catalog_revisions (created_by, based_on_revision_id)
       VALUES ($1, $2) RETURNING id`,
      [createdBy, live.revisionId],
    );
    await client.query(
      `INSERT INTO plan_catalog_prices (revision_id, source, lookup_key, plan, period, tier)
       SELECT $1, source, lookup_key, plan, period, tier
         FROM plan_catalog_prices WHERE revision_id = $2`,
      [rev.id, live.revisionId],
    );
    await client.query(
      `INSERT INTO plan_catalog_amounts (price_id, currency, unit_amount_minor, tax_behavior)
       SELECT np.id, a.currency, a.unit_amount_minor, a.tax_behavior
         FROM plan_catalog_amounts a
         JOIN plan_catalog_prices op ON op.id = a.price_id
         JOIN plan_catalog_prices np
           ON np.revision_id = $1 AND np.source = op.source AND np.lookup_key = op.lookup_key
        WHERE op.revision_id = $2`,
      [rev.id, live.revisionId],
    );
    return rev.id;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/db/publish-repo`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/db/publish-repo.ts apps/console/lib/db/publish-repo.integration.test.ts
git commit -m "feat(console): draft revisions, copied from the mode's published catalog"
```

---

### Task 2: The write client

**Files:**
- Create: `apps/console/lib/billing/mark8ly/stripe-write.ts`
- Create: `apps/console/lib/billing/mark8ly/stripe-write.test.ts`

**Interfaces:**
- Produces: `stripeCatalogWriter` with `createProduct(mode, plan)`, `findProductByPlan(mode, plan)`, `createPrice(mode, spec)`, `updatePriceCurrencyOptions(mode, priceId, options)`, `updatePriceTaxBehavior(mode, priceId, behavior)`, `archivePrice(mode, priceId)`. `WRITE_KEY_ENV: Record<StripeMode, string>`.

- [ ] **Step 1: Write the failing test**

```ts
it("exposes no method whose name suggests anything but these six", () => {
  // Named individually so this fails on the NEXT change rather than counting.
  // #327 revokes mark8ly's write key on the strength of the read client having
  // no writes; this is the mirror-image guard on the write client having no
  // surprises.
  expect(Object.keys(stripeCatalogWriter).sort()).toEqual([
    "archivePrice", "createPrice", "createProduct",
    "findProductByPlan", "updatePriceCurrencyOptions", "updatePriceTaxBehavior",
  ]);
});

it("never exposes the underlying Stripe instance", () => {
  for (const value of Object.values(stripeCatalogWriter)) {
    expect(typeof value).toBe("function");
  }
});

it("reads a per-mode key and fails clearly when it is absent", async () => {
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", "");
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro"))
    .rejects.toThrow(/STRIPE_WRITE_KEY_TEST/);
});

it("refuses a key whose prefix contradicts its mode", async () => {
  // An rk_live_ in the test slot cost an hour on 2026-08-27 and produced a
  // report claiming all 42 prices were missing. On the WRITE side the same
  // mistake would create 42 prices in the wrong account.
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", ["sk", "live", "abc123"].join("_"));
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro"))
    .rejects.toThrow(/mode/i);
});

it("sends transfer_lookup_key when creating a replacement price", async () => {
  await stripeCatalogWriter.createPrice("test", {
    productId: "prod_x", lookupKey: "mark8ly_pro_monthly_developed_v1",
    currency: "usd", unitAmount: 10_700, interval: "month",
    taxBehavior: "unspecified", currencyOptions: {}, transferLookupKey: true,
    idempotencyKey: "k1",
  });
  expect(created).toMatchObject({ transfer_lookup_key: true, lookup_key: "mark8ly_pro_monthly_developed_v1" });
});

it("never puts the baseline currency inside currency_options", async () => {
  // Stripe REJECTS the call outright. This exact rejection stuck a mark8ly
  // bootstrap run and is why its idempotency key is at v3.
  await stripeCatalogWriter.createPrice("test", {
    productId: "prod_x", lookupKey: "k", currency: "usd", unitAmount: 100,
    interval: "month", taxBehavior: "unspecified",
    currencyOptions: { usd: { unitAmount: 100 }, gbp: { unitAmount: 90 } },
    idempotencyKey: "k2",
  });
  expect(Object.keys(created.currency_options)).toEqual(["gbp"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/mark8ly/stripe-write`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import "server-only";
import Stripe from "stripe";
import type { StripeMode } from "../stripe-read";

export const WRITE_KEY_ENV: Record<StripeMode, string> = {
  test: "STRIPE_WRITE_KEY_TEST",
  live: "STRIPE_WRITE_KEY_LIVE",
};

/** Expected key prefix per mode. A mismatch is refused rather than used: on
 *  the write side, the wrong account means 42 prices created in it. */
const EXPECTED_PREFIX: Record<StripeMode, string> = { test: "sk_test_", live: "sk_live_" };

// Module-private and NEVER returned. Returning it would hand every caller the
// full write API and make the six-method surface decorative.
const clients = new Map<string, Stripe>();

function client(mode: StripeMode): Stripe {
  const variable = WRITE_KEY_ENV[mode];
  const key = process.env[variable];
  if (!key) throw new StripeWriteUnavailableError(`${variable} is not set`);
  if (!key.startsWith(EXPECTED_PREFIX[mode])) {
    throw new StripeWriteUnavailableError(
      `${variable} holds a key for a different mode (expected ${EXPECTED_PREFIX[mode]}…)`,
    );
  }
  // Memoised against the key VALUE so a rotation takes effect without a
  // restart and does not disturb the other mode.
  const cached = clients.get(key);
  if (cached) return cached;
  const made = new Stripe(key, { apiVersion: API_VERSION });
  clients.set(key, made);
  return made;
}
```

`createPrice` filters the baseline out of `currencyOptions` before sending, and passes `idempotencyKey` through as Stripe's request option.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/billing/mark8ly/stripe-write`
Expected: PASS, 6 tests. No live Stripe call — the SDK is mocked with `vi.mock("stripe")`.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/billing/mark8ly/stripe-write.ts apps/console/lib/billing/mark8ly/stripe-write.test.ts
git commit -m "feat(console): a Stripe write client with six methods and no instance escape"
```

---

### Task 3: The three-way publish plan

**Files:**
- Create: `apps/console/lib/billing/publish-plan.ts`, `publish-plan.test.ts`

**Interfaces:**
- Consumes: `CatalogAmount`, `StripePriceLike`, `compareCatalogToStripe`, `SourcePolicy` (Plan 1).
- Produces: `buildPublishPlan(input): PublishPlan`; `PublishOperation` union with kinds `create_product | create_price | replace_price | update_currency_options | update_tax_behavior | archive_price`, each carrying `origin: "intended" | "drift-correction"`; `PublishPlan { operations, fingerprint, counts }`.

- [ ] **Step 1: Write the failing test**

```ts
it("labels a change the operator made as intended", () => {
  const plan = buildPublishPlan({
    ancestor: [amount("k_usd", "usd", 1000)],
    draft:    [amount("k_usd", "usd", 1200)],
    observed: [price({ lookup_key: "k_usd", currency: "usd", unit_amount: 1000 })],
  });
  expect(plan.operations.map((o) => o.origin)).toEqual(["intended"]);
});

it("labels a Stripe-side edit as drift-correction, and still publishes it", () => {
  // Without the label, publishing silently reverts a Dashboard change and
  // nobody is told. The operator sees both counts before confirming.
  const plan = buildPublishPlan({
    ancestor: [amount("k_usd", "usd", 1000)],
    draft:    [amount("k_usd", "usd", 1000)],
    observed: [price({ lookup_key: "k_usd", currency: "usd", unit_amount: 999 })],
  });
  expect(plan.operations.map((o) => o.origin)).toEqual(["drift-correction"]);
});

it("classifies a non-baseline currency edit as an in-place update", () => {
  const plan = buildPublishPlan({ /* gbp differs; usd is the baseline */ });
  expect(plan.operations[0].kind).toBe("update_currency_options");
});

it("classifies a baseline-currency edit as a replacement", () => {
  // unit_amount is immutable, so the usd cell can only be changed by minting
  // a new Price and transferring the lookup key.
  const plan = buildPublishPlan({ /* usd differs */ });
  expect(plan.operations[0].kind).toBe("replace_price");
});

it("classifies a tax_behavior change FROM a set value as a replacement", () => {
  // "Once specified as either inclusive or exclusive, it cannot be changed."
  // All six aud cells are already exclusive.
  const plan = buildPublishPlan({ /* aud exclusive -> inclusive */ });
  expect(plan.operations[0].kind).toBe("replace_price");
});

it("emits create_product before any create_price that references it", () => {
  const plan = buildPublishPlan({ ancestor: [], draft: FULL_CATALOG, observed: [] });
  const kinds = plan.operations.map((o) => o.kind);
  expect(kinds.indexOf("create_product")).toBeLessThan(kinds.indexOf("create_price"));
  expect(plan.counts).toMatchObject({ create_product: 3, create_price: 42 });
});

it("carries all six non-baseline currencies on an in-place update", () => {
  // Whether Stripe merges or replaces the map is UNVERIFIED (spec §1.6).
  // Sending all six is correct under either, so it is not conditional.
  const op = buildPublishPlan({ /* one gbp change */ }).operations[0];
  expect(Object.keys(op.currencyOptions).sort()).toEqual(["aud", "cad", "eur", "gbp", "nzd", "sgd"]);
});

it("fingerprints the observation it planned against", () => {
  const a = buildPublishPlan({ observed: [price({ lookup_key: "k", currency: "usd", unit_amount: 100 })] });
  const b = buildPublishPlan({ observed: [price({ lookup_key: "k", currency: "usd", unit_amount: 101 })] });
  expect(a.fingerprint).not.toBe(b.fingerprint);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/publish-plan`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Pure function, no I/O and no `stripe` import — only types, so it stays fixture-testable and cannot drag the SDK into a browser bundle.

- `draft vs observed` via `compareCatalogToStripe` gives what must change.
- `draft vs ancestor` gives `intended`; anything else is `drift-correction`.
- Classification follows the spec's §4 table.
- `fingerprint` is a SHA-256 over the sorted observed `(lookup_key, currency, unit_amount, tax_behavior)` tuples.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/billing/publish-plan`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/billing/publish-plan.ts apps/console/lib/billing/publish-plan.test.ts
git commit -m "feat(console): a three-way publish plan that separates intent from drift"
```

---

### Task 4: Guards

**Files:**
- Create: `apps/console/lib/billing/publish-guards.ts`, `publish-guards.test.ts`

**Interfaces:**
- Produces: `checkGuards(plan, ancestor, mode): GuardVerdict` where `GuardVerdict = { ok: true } | { ok: false; requiresConfirmation: GuardBreach[] } | { ok: false; refused: GuardBreach[] }`.

- [ ] **Step 1: Write the failing test**

```ts
it("requires confirmation when an amount moves more than 25% from the ancestor", () => {
  // Measured against the ANCESTOR, not observed Stripe: a dropped zero is a
  // divergence from prior INTENT. Against observed, correcting real drift
  // would trip the guard and a typo coinciding with drift would pass it.
  const v = checkGuards(planWithAmountChange(1000, 100), ancestorAt(1000), "test");
  expect(v).toMatchObject({ ok: false });
});

it("passes a routine single-cell edit", () => {
  expect(checkGuards(planWithAmountChange(1000, 1100), ancestorAt(1000), "test")).toEqual({ ok: true });
});

it("counts breadth in INTENDED entries, not drift corrections", () => {
  // "40 entries" is meaningless. "1 intended, 39 drift" and "40 intended" are
  // entirely different events.
  expect(checkGuards(planWith({ intended: 1, drift: 39 }), ANY, "test")).toEqual({ ok: true });
  expect(checkGuards(planWith({ intended: 11, drift: 0 }), ANY, "test")).toMatchObject({ ok: false });
});

it("refuses a developed price that does not carry all seven currencies", () => {
  // Not a Stripe error — it is checkout failing in the UK. No operation in the
  // plan catches it, because "fewer currencies" is a legitimate in-place update.
  const v = checkGuards(planDropping("gbp"), ANY, "test");
  expect(v).toMatchObject({ refused: [expect.objectContaining({ rule: "currency-coverage" })] });
});

it("refuses any live publish in v1", () => {
  expect(checkGuards(TRIVIAL_PLAN, ANY, "live")).toMatchObject({
    refused: [expect.objectContaining({ rule: "mode" })],
  });
});

it("treats a bootstrap as requiring confirmation, not refusal", () => {
  // 42 creates into an empty mode is legitimate and expected after the wipe.
  expect(checkGuards(BOOTSTRAP_PLAN, EMPTY_ANCESTOR, "test")).toMatchObject({ ok: false, requiresConfirmation: expect.anything() });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/publish-guards`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Pure functions. `MAGNITUDE_THRESHOLD = 0.25`, `BREADTH_THRESHOLD = 10` as named exported constants with the reasoning in comments. Currency coverage and mode are **refusals**, not confirmations — they are never legitimate in v1.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/billing/publish-guards`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/billing/publish-guards.ts apps/console/lib/billing/publish-guards.test.ts
git commit -m "feat(console): guards against a correct mechanism publishing a wrong number"
```

---

### Task 5: Migration 0036 — publish attempts and the operation log

**Files:**
- Create: `apps/web/db/migrations/0036_publish_operations.sql`
- Test: `apps/console/lib/db/publish-operations.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("refuses an operation row with no attempt", async () => {
  await expect(insertOperationWithoutAttempt()).rejects.toThrow(/violates/);
});

it("refuses a succeeded row with no finished_at", async () => {
  await expect(insertOperation({ status: "succeeded", finishedAt: null })).rejects.toThrow(/coherent/);
});

it("refuses a failed row with no error", async () => {
  await expect(insertOperation({ status: "failed", error: null })).rejects.toThrow(/coherent/);
});

it("allows two rows for one replace_price, because it is two Stripe calls", async () => {
  const attempt = await insertAttempt();
  await insertOperation({ attempt, sequence: 1, stripeCall: "create" });
  await expect(insertOperation({ attempt, sequence: 2, stripeCall: "archive" })).resolves.toBeDefined();
});

it("refuses two operations with the same sequence in one attempt", async () => {
  const attempt = await insertAttempt();
  await insertOperation({ attempt, sequence: 1 });
  await expect(insertOperation({ attempt, sequence: 1 })).rejects.toThrow(/unique/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/db/publish-operations`
Expected: FAIL — `ENOENT` on `0036_publish_operations.sql`.

- [ ] **Step 3: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS plan_catalog_publish_attempts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    revision_id  uuid NOT NULL REFERENCES plan_catalog_revisions (id) ON DELETE RESTRICT,
    mode         text NOT NULL CHECK (mode IN ('test', 'live')),
    -- The observation this plan was built against. Re-observed at execution;
    -- a change ABORTS. Without it the operator confirms a plan computed at T
    -- and something else executes at T+n.
    fingerprint  text NOT NULL,
    started_by   text NOT NULL,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    outcome      text CHECK (outcome IN ('succeeded', 'failed', 'aborted'))
);

CREATE TABLE IF NOT EXISTS plan_catalog_publish_operations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id  uuid NOT NULL REFERENCES plan_catalog_publish_attempts (id) ON DELETE CASCADE,
    sequence    integer NOT NULL,
    kind        text NOT NULL,
    -- ONE ROW PER STRIPE CALL, not per plan entry. A replace_price is a create
    -- AND an archive, and orphan detection needs the archived id specifically.
    stripe_call text NOT NULL CHECK (stripe_call IN ('create', 'update', 'archive')),
    source      text NOT NULL,
    lookup_key  text,
    currency    text,
    -- Captured BEFORE the create for a replacement: once the new price claims
    -- the lookup key, the old one is addressable only by id, and resolving by
    -- key at archive time archives the price just minted.
    stripe_price_id text,
    idempotency_key text NOT NULL,
    status      text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
    error       text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,

    CONSTRAINT plan_catalog_publish_operations_one_per_sequence UNIQUE (attempt_id, sequence),
    CONSTRAINT plan_catalog_publish_operations_status_is_coherent
    CHECK (
        (status = 'pending'   AND finished_at IS NULL AND error IS NULL) OR
        (status = 'succeeded' AND finished_at IS NOT NULL AND error IS NULL) OR
        (status = 'failed'    AND finished_at IS NOT NULL AND error IS NOT NULL)
    )
);

-- The 2am question is "what happened to THIS price".
CREATE INDEX IF NOT EXISTS plan_catalog_publish_operations_lookup_key
    ON plan_catalog_publish_operations (lookup_key);
-- Orphan detection scans archived ids.
CREATE INDEX IF NOT EXISTS plan_catalog_publish_operations_archived
    ON plan_catalog_publish_operations (stripe_price_id)
    WHERE stripe_call = 'archive';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/db/publish-operations`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/db/migrations/0036_publish_operations.sql apps/console/lib/db/publish-operations.integration.test.ts
git commit -m "feat(console): publish attempts and a per-Stripe-call operation log"
```

---

### Task 6: The executor

**Files:**
- Create: `apps/console/lib/billing/publish-executor.ts`, `publish-executor.test.ts`

**Interfaces:**
- Consumes: `stripeCatalogWriter` (Task 2), `buildPublishPlan` (Task 3), `checkGuards` (Task 4), the log (Task 5).
- Produces: `executePublish(attemptId): Promise<PublishOutcome>` where `PublishOutcome = { outcome: "succeeded" | "failed" | "aborted"; operations: OperationResult[] }`.

- [ ] **Step 1: Write the failing test**

```ts
it("writes the operation row BEFORE calling Stripe", async () => {
  // If this order ever inverts, a crash between the two produces exactly the
  // "Stripe changed with no record" gap the design exists to prevent.
  const seen: string[] = [];
  await executeWith({ onDbWrite: () => seen.push("db"), onStripeCall: () => seen.push("stripe") });
  expect(seen).toEqual(["db", "stripe"]);
});

it("leaves a pending row when the process dies after the write", async () => {
  await expect(executeWithFailureAfterDbWrite()).rejects.toThrow();
  expect(await statusOf(1)).toBe("pending");
});

it("aborts without calling Stripe when the observation moved", async () => {
  const attempt = await startAttempt({ fingerprint: "old" });
  mockObservation({ fingerprint: "new" });
  const result = await executePublish(attempt);
  expect(result.outcome).toBe("aborted");
  expect(stripeCalls).toHaveLength(0);
});

it("captures the old price id before creating its replacement", async () => {
  await executePublish(await startAttemptWithReplacement());
  const [create, archive] = await operationsFor();
  expect(archive.stripe_price_id).toBe(OLD_PRICE_ID);
  expect(archive.stripe_price_id).not.toBe(create.stripe_price_id);
});

it("puts the attempt number in the idempotency key", async () => {
  // Stripe replays cached FAILURES and expires keys after 24h. mark8ly already
  // deadlocked on this and bumped its key v1 -> v3. Without an attempt
  // counter, a retry of a transiently-failed operation gets the cached error
  // back forever.
  const first = await executePublish(await startAttempt());
  const second = await executePublish(await startAttempt());
  expect(keyOf(first, 1)).not.toBe(keyOf(second, 1));
});

it("re-running a completed publish produces an empty plan", async () => {
  await executePublish(attempt);
  const plan = await planFor(attempt.revisionId, "test");
  expect(plan.operations).toEqual([]);
});

it("does not stop the whole publish when one operation fails", async () => {
  const result = await executePublish(await startAttemptWhereOperation2Fails());
  expect(result.operations.map((o) => o.status)).toEqual(["succeeded", "failed", "succeeded"]);
  expect(result.outcome).toBe("failed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/publish-executor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Order per operation: re-observe → compare fingerprint → abort or continue → insert `pending` row → call Stripe → update row. Creates precede archives so the old id is captured first. **Recovery is re-observe-and-re-plan**, not draining the queue; the log is audit.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/billing/publish-executor`
Expected: PASS, 7 tests. No live Stripe call.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/billing/publish-executor.ts apps/console/lib/billing/publish-executor.test.ts
git commit -m "feat(console): a write-ahead, fingerprinted, resumable publish executor"
```

---

### Task 7: Promotion and orphan detection

**Files:**
- Create: `apps/console/lib/billing/orphans.ts`, `orphans.test.ts`
- Modify: `apps/console/lib/db/publish-repo.ts`

**Interfaces:**
- Produces: `promotePublication(mode, revisionId, by): Promise<string>`; `findOrphans(mode): Promise<Orphan[]>`.

- [ ] **Step 1: Write the failing test**

```ts
it("retires the previous publication and promotes the new one atomically", async () => {
  const before = (await readLivePublication("test"))!.id;
  await promotePublication("test", NEW_REVISION, "operator");
  const after = (await readLivePublication("test"))!.id;
  expect(after).not.toBe(before);
  expect(await supersededAtOf(before)).not.toBeNull();
});

it("serialises two concurrent promotions to the same mode", async () => {
  // Without an advisory lock, B's "retire whatever is live" retires A's
  // brand-new publication under READ COMMITTED, silently discarding it.
  const [a, b] = await Promise.allSettled([
    promotePublication("test", REV_A, "a"),
    promotePublication("test", REV_B, "b"),
  ]);
  const live = await allLivePublications("test");
  expect(live).toHaveLength(1);
});

it("finds a price that was archived in the log but is still active in Stripe", async () => {
  // THE failure the parity check structurally cannot see: parity.ts skips
  // every price with a null lookup_key, and a transferred-away price has one.
  // It reports clean, with the expected 42.
  mockStripeActive([OLD_PRICE_ID]);
  const orphans = await findOrphans("test");
  expect(orphans.map((o) => o.priceId)).toEqual([OLD_PRICE_ID]);
});

it("finds nothing when every archived price really is archived", async () => {
  mockStripeActive([]);
  expect(await findOrphans("test")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/orphans lib/db/publish-repo`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export async function promotePublication(mode: StripeMode, revisionId: string, by: string): Promise<string> {
  return runTesserixTx(async (client) => {
    // Scoped to the mode. The partial unique index is a ceiling, not a
    // serialiser: two transactions can both read "whatever is live" and the
    // second retires what the first just promoted.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`plan_catalog_publish:${mode}`]);
    await client.query(
      `UPDATE plan_catalog_publications
          SET superseded_at = now(), superseded_by = $2
        WHERE mode = $1 AND superseded_at IS NULL`,
      [mode, by],
    );
    const { rows: [pub] } = await client.query<{ id: string }>(
      `INSERT INTO plan_catalog_publications (mode, revision_id, published_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [mode, revisionId, by],
    );
    return pub.id;
  });
}
```

`findOrphans` reads archived `stripe_price_id`s from the log and asks Stripe whether each is still `active`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/billing lib/db`
Expected: PASS.

- [ ] **Step 5: Full suite and build**

Run: `pnpm --filter console exec vitest run` then `pnpm --filter console build` and `build:cron`
Expected: PASS; `next build` succeeds; the cron bundle keeps `pg` external and `stripe` inlined.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(console): atomic publication promotion and orphan detection"
```

---

## The [X] experiments — run once, before Task 6 ships

Three facts this plan depends on are **inferences, not verified** (spec §1). Each is a cheap one-off against test mode; record the answers in the spec.

- [ ] Does a partial `currency_options` update REMOVE absent currencies, or merge? (§1.6 — the mitigation is safe either way, but the answer decides whether a bug here is loud or silent.)
- [ ] Can `tax_behavior` be set FROM `unspecified` via update? (§1.4 — if not, `update_tax_behavior` must be deleted from the plan's operations and every case becomes `replace_price`.)
- [ ] Does an in-place `currency_options` change alter an existing subscription's next invoice? (§6 — this is the claim the whole "loudest confirmation on the in-place path" inversion rests on.)

## Definition of done

- A draft can be created, edited, planned, guarded and published to **test mode**.
- The plan distinguishes intended change from drift correction, and the operator sees both counts.
- A half-failed publish leaves a readable log, a detectable orphan, and a resumable state.
- Publishing to live is refused.
- No path exists by which the parity check can write to Stripe.
