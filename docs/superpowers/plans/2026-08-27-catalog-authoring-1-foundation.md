# Catalog Authoring — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plan catalog versioned, per-mode, per-product, and make the parity comparator check enough that "clean" means Stripe matches desired state.

**Architecture:** Adds `plan_catalog_revisions` and `plan_catalog_publications` so a draft can exist alongside what Stripe reflects, and so publication is per Stripe mode. Decouples mark8ly's ×100 amount convention from the shared comparator. Widens the comparator to check `recurring.interval`, `product` and `active`, without which a created price could be wrong forever and still report clean. **No write path to Stripe in this plan.**

**Tech Stack:** TypeScript, Next.js 16, Postgres (pglite for tests), vitest, `stripe` v22.

**Spec:** `docs/superpowers/specs/2026-08-27-console-catalog-authoring-design.md`

## Global Constraints

- **Baseline is PR #378** (`feat/parity-dual-mode`). It must be merged and its `0034` applied to prod first. This plan's migration is `0035`.
- **Migrations are applied to production manually BEFORE the PR merges.** Estate convention, not preference.
- pnpm workspace. `npm ci` FAILS — there is no `package-lock.json`.
- Rebuild `packages/console-core` before running app tests.
- Run vitest scoped: `pnpm --filter console exec vitest run <path>`. From the repo root the `@/` alias is silently lost and you get spurious module-not-found failures.
- `tsc` is not a build. Run `next build` before finishing.
- TDD: write the failing test, watch it fail, implement, watch it pass, commit.
- Comment register: say WHY a choice was made and what breaks otherwise. Match `0032_plan_catalog.sql` and `parity.ts`.
- **No Stripe writes anywhere in this plan.** The read client keeps its restricted key.

---

## File Structure

| file | responsibility |
|---|---|
| `apps/web/db/migrations/0035_plan_catalog_revisions.sql` | revisions, publications, `source`, `revision_id`, constraint swap, `publication_id` on parity runs |
| `apps/console/lib/billing/source-policy.ts` | per-source catalog conventions — currently only the ×100 scaling |
| `apps/console/lib/billing/parity.ts` | widened comparator: interval, product, active |
| `apps/console/lib/db/plan-catalog-repo.ts` | mode- and publication-aware reads and writes |

---

### Task 1: Migration 0035 — revisions, publications, source

**Files:**
- Create: `apps/web/db/migrations/0035_plan_catalog_revisions.sql`
- Test: `apps/console/lib/db/plan-catalog-revisions.integration.test.ts`

**Interfaces:**
- Consumes: `0032_plan_catalog.sql` (`plan_catalog_prices`, `plan_catalog_amounts`), `0034_parity_runs_mode.sql` (`mode` on `plan_catalog_parity_runs`).
- Produces: tables `plan_catalog_revisions`, `plan_catalog_publications`; columns `plan_catalog_prices.revision_id`, `plan_catalog_prices.source`, `plan_catalog_parity_runs.publication_id`.

- [ ] **Step 1: Write the failing test**

Create `apps/console/lib/db/plan-catalog-revisions.integration.test.ts`, following the pglite setup in `plan-catalog-parity-runs-mode.integration.test.ts` (apply 0032, 0033, 0034, then 0035):

```ts
it("lets a draft and the published revision hold the same lookup key", async () => {
  // The whole point of the constraint swap. Under 0032's global UNIQUE this
  // INSERT fails, and draft creation would fail on its first row.
  const draft = await insertRevision("drafting a price change");
  await expect(
    insertPrice(draft, "mark8ly", "mark8ly_pro_annual_developed_v1"),
  ).resolves.toBeDefined();
});

it("refuses two live publications for one mode", async () => {
  const a = await insertRevision("a");
  const b = await insertRevision("b");
  await publish("test", a);
  await expect(publish("test", b)).rejects.toThrow(/one_live_per_mode/);
});

it("allows the same revision to be published to both modes", async () => {
  const r = await insertRevision("shared");
  await publish("test", r);
  await expect(publish("live", r)).resolves.toBeDefined();
});

it("refuses to delete a revision that has been published", async () => {
  const r = await insertRevision("published");
  await publish("test", r);
  await expect(deleteRevision(r)).rejects.toThrow(/violates foreign key/);
});

it("cascades amounts when a draft's prices are deleted", async () => {
  const draft = await insertRevision("throwaway");
  const price = await insertPrice(draft, "mark8ly", "mark8ly_x_v1");
  await insertAmount(price, "usd", 1000, "unspecified");
  await deletePricesFor(draft);
  expect(await countAmountsFor(price)).toBe(0);
});

it("requires a source, with no default to inherit", async () => {
  const draft = await insertRevision("no source");
  await expect(insertPriceWithoutSource(draft)).rejects.toThrow(/source/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/db/plan-catalog-revisions`
Expected: FAIL — `ENOENT` opening `0035_plan_catalog_revisions.sql`.

- [ ] **Step 3: Write the migration**

```sql
-- The catalog becomes versioned, per-mode, and per-product.
--
-- WHY A REVISION AT ALL. Editing must not touch what Stripe currently
-- reflects, and the parity check must have an unambiguous answer to "compare
-- against what?". One published revision per mode answers both, and the audit
-- trail falls out rather than being built.
--
-- WHY PUBLICATION IS A SEPARATE TABLE. A status column on the revision cannot
-- express "test is ahead of live", which is the NORMAL state here: live has
-- never been bootstrapped. Publication is a fact about a (mode, revision)
-- pair, not about a revision.

CREATE TABLE IF NOT EXISTS plan_catalog_revisions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    note       text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- The common ancestor. A plan is three-way — draft vs ancestor tells us
    -- what the operator INTENDED, draft vs Stripe tells us what DRIFTED, and
    -- without the distinction publishing silently reverts a Dashboard edit and
    -- nobody is told.
    based_on_revision_id uuid REFERENCES plan_catalog_revisions (id)
);

ALTER TABLE plan_catalog_prices
    ADD COLUMN IF NOT EXISTS revision_id uuid REFERENCES plan_catalog_revisions (id) ON DELETE CASCADE;

-- WHY `source` NOW. It costs nothing at 42 rows and is expensive once two
-- products share the table: retrofitting a discriminator means backfilling
-- live data and auditing every query that assumed one product, including the
-- parity check whose window gates a key revocation. Mirrors how entity rows
-- already carry their source (contract §8.9).
ALTER TABLE plan_catalog_prices
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mark8ly';

INSERT INTO plan_catalog_revisions (id, note, created_by)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Baseline: the catalog as seeded by 0032, before authoring existed.',
    'migration:0035'
)
ON CONFLICT (id) DO NOTHING;

UPDATE plan_catalog_prices
   SET revision_id = '00000000-0000-0000-0000-000000000001'
 WHERE revision_id IS NULL;

ALTER TABLE plan_catalog_prices ALTER COLUMN revision_id SET NOT NULL;

-- The default existed only to make the ALTER succeed on a populated table.
-- Dropping it means a future writer must STATE the source rather than inherit
-- one — the same reasoning 0034 applied to `mode`.
ALTER TABLE plan_catalog_prices ALTER COLUMN source DROP DEFAULT;

-- NOT OPTIONAL, AND NOT A FOLLOW-UP. 0032 made `lookup_key` globally unique.
-- A draft and the published revision both hold
-- `mark8ly_pro_annual_developed_v1`, so draft creation fails on its FIRST
-- insert while the application looks buggy for a reason it cannot see.
ALTER TABLE plan_catalog_prices DROP CONSTRAINT IF EXISTS plan_catalog_prices_lookup_key_key;

ALTER TABLE plan_catalog_prices
    ADD CONSTRAINT plan_catalog_prices_lookup_key_unique_per_revision
    UNIQUE (revision_id, source, lookup_key);

CREATE TABLE IF NOT EXISTS plan_catalog_publications (
    -- SURROGATE, not (mode, revision_id): re-publishing a previously
    -- superseded revision is a second row for the same pair.
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mode          text NOT NULL
                  CONSTRAINT plan_catalog_publications_mode_is_a_stripe_mode
                  CHECK (mode IN ('test', 'live')),
    -- RESTRICT, NOT CASCADE, and the difference matters. `prices.revision_id`
    -- cascades so discarding a draft is one delete. If this cascaded too, that
    -- same cleanup would silently erase who published what and when, out from
    -- under the parity runs that reference it.
    revision_id   uuid NOT NULL REFERENCES plan_catalog_revisions (id) ON DELETE RESTRICT,
    published_at  timestamptz NOT NULL DEFAULT now(),
    published_by  text NOT NULL,
    superseded_at timestamptz,
    superseded_by text,

    CONSTRAINT plan_catalog_publications_supersession_is_coherent
    CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))
);

-- A CEILING, never a floor. Postgres cannot express "at least one", so
-- "exactly one published" is a property of the publish TRANSACTION (retire
-- then promote, under an advisory lock on the mode), not of this schema.
-- Claiming otherwise would be claiming more than is enforced.
CREATE UNIQUE INDEX IF NOT EXISTS plan_catalog_publications_one_live_per_mode
    ON plan_catalog_publications (mode) WHERE superseded_at IS NULL;

INSERT INTO plan_catalog_publications (mode, revision_id, published_by)
SELECT 'test', '00000000-0000-0000-0000-000000000001', 'migration:0035'
WHERE NOT EXISTS (
    SELECT 1 FROM plan_catalog_publications WHERE mode = 'test' AND superseded_at IS NULL
);

-- WHICH catalog was that run clean against? Once "published" is mutable, a
-- `clean` row from three days ago is ambiguous — and this table exists
-- precisely to be trustworthy after the fact. `publication_id` carries both
-- the mode and the revision, so it is a better answer than either alone.
ALTER TABLE plan_catalog_parity_runs
    ADD COLUMN IF NOT EXISTS publication_id uuid REFERENCES plan_catalog_publications (id);

CREATE INDEX IF NOT EXISTS plan_catalog_parity_runs_publication_id
    ON plan_catalog_parity_runs (publication_id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/db/plan-catalog-revisions`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify re-runnability against real Postgres**

```bash
pnpm --filter console dev:db:up
pnpm --filter console dev:db:migrate
pnpm --filter console dev:db:migrate   # second time: no errors, no duplicate rows
```
Expected: the second run reports the migration already applied and leaves counts unchanged (42 prices, 78 amounts, 1 revision, 1 publication).

- [ ] **Step 6: Commit**

```bash
git add apps/web/db/migrations/0035_plan_catalog_revisions.sql apps/console/lib/db/plan-catalog-revisions.integration.test.ts
git commit -m "feat(console): version the plan catalog, per mode and per source"
```

---

### Task 2: Decouple mark8ly's ×100 convention from the shared comparator

**Files:**
- Create: `apps/console/lib/billing/source-policy.ts`
- Create: `apps/console/lib/billing/source-policy.test.ts`
- Modify: `apps/console/lib/billing/parity.ts`

**Interfaces:**
- Produces: `export type CatalogSource = "mark8ly"`, `export interface SourcePolicy { amountsAreScaledBy100: boolean }`, `export function policyFor(source: CatalogSource): SourcePolicy`, `export function toStripeUnitAmount(currency: string, catalogMinor: number, policy: SourcePolicy): number`.
- Consumed by: Task 3's comparator, and Plan 2's write path.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { policyFor, toStripeUnitAmount } from "./source-policy";

describe("source policy", () => {
  it("scales mark8ly's zero-decimal amounts down, because its catalog stores them x100", () => {
    // VND is zero-decimal in Stripe. mark8ly stores 1978800000 for the price
    // Stripe holds as 19788000. Verified against live data 2026-08-27.
    expect(toStripeUnitAmount("vnd", 1_978_800_000, policyFor("mark8ly"))).toBe(19_788_000);
  });

  it("leaves IDR alone — it is NOT zero-decimal in Stripe", () => {
    expect(toStripeUnitAmount("idr", 19_900_000, policyFor("mark8ly"))).toBe(19_900_000);
  });

  it("leaves zero-decimal amounts alone for a source that does not scale", () => {
    // THE REASON THIS MODULE EXISTS. A product storing genuine minor units
    // would have every VND/JPY/KRW price divided by 100 if the x100 rule
    // stayed hard-coded in the shared comparator.
    expect(toStripeUnitAmount("vnd", 329_000, { amountsAreScaledBy100: false })).toBe(329_000);
  });

  it("leaves ordinary currencies alone under either policy", () => {
    expect(toStripeUnitAmount("usd", 2900, policyFor("mark8ly"))).toBe(2900);
    expect(toStripeUnitAmount("usd", 2900, { amountsAreScaledBy100: false })).toBe(2900);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/source-policy`
Expected: FAIL — cannot find module `./source-policy`.

- [ ] **Step 3: Write the module**

```ts
import { ZERO_DECIMAL_CURRENCIES } from "./parity";

/**
 * Which product's catalog a row belongs to.
 *
 * A union of one today. It exists so the type system says "this is per
 * product" out loud, rather than a second product discovering the assumption
 * by having its prices come out wrong.
 */
export type CatalogSource = "mark8ly";

/**
 * The conventions a product's catalog follows, which are NOT facts about
 * Stripe.
 */
export interface SourcePolicy {
  /**
   * Does this catalog store zero-decimal amounts multiplied by 100?
   *
   * mark8ly's does, for internal consistency, and `billing-bootstrap` divides
   * at the Stripe boundary (`internal/billing/stripe/price.go`). That is a
   * mark8ly decision, not a Stripe rule — and it lived in the shared
   * comparator until 2026-08-27, where a second product storing genuine minor
   * units would have had every VND, JPY and KRW price divided by 100 on write
   * and mis-compared on read.
   */
  readonly amountsAreScaledBy100: boolean;
}

const POLICIES: Record<CatalogSource, SourcePolicy> = {
  mark8ly: { amountsAreScaledBy100: true },
};

export function policyFor(source: CatalogSource): SourcePolicy {
  return POLICIES[source];
}

/**
 * A catalog amount expressed the way Stripe stores it.
 *
 * The zero-decimal SET is a Stripe fact and stays shared. The x100
 * CONVENTION is the product's and arrives via `policy`.
 */
export function toStripeUnitAmount(
  currency: string,
  catalogMinor: number,
  policy: SourcePolicy,
): number {
  if (!policy.amountsAreScaledBy100) return catalogMinor;
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? catalogMinor / 100 : catalogMinor;
}
```

- [ ] **Step 4: Point the comparator at it**

In `apps/console/lib/billing/parity.ts`, delete the private `toStripeUnitAmount` and import the shared one. `compareCatalogToStripe` gains a `policy` parameter defaulting to `policyFor("mark8ly")`, so existing call sites keep compiling while the default is explicit rather than implied:

```ts
import { policyFor, toStripeUnitAmount, type SourcePolicy } from "./source-policy";

export function compareCatalogToStripe(
  catalogAmounts: readonly CatalogAmount[],
  stripePrices: readonly StripePriceLike[],
  namespacePrefix: string = MARK8LY_LOOKUP_KEY_PREFIX,
  policy: SourcePolicy = policyFor("mark8ly"),
): ParityReport {
```

and at the comparison site:

```ts
const catalogAsStripeStores = toStripeUnitAmount(currency, catalogMinor, policy);
```

- [ ] **Step 5: Run the full parity suite to verify nothing regressed**

Run: `pnpm --filter console exec vitest run lib/billing`
Expected: PASS — the existing 24 comparator tests and the new 4, unchanged in behaviour.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/billing/source-policy.ts apps/console/lib/billing/source-policy.test.ts apps/console/lib/billing/parity.ts
git commit -m "refactor(console): move the x100 convention behind a per-source policy"
```

---

### Task 3: Widen the comparator — interval, product, active

**Files:**
- Modify: `apps/console/lib/billing/parity.ts`
- Modify: `apps/console/lib/billing/stripe-read.ts`
- Test: `apps/console/lib/billing/parity.test.ts`

**Interfaces:**
- Consumes: `CatalogAmount` (Task 1 adds nothing to it), `SourcePolicy` (Task 2).
- Produces: `StripePriceLike` gains `readonly product: string | null` and `readonly recurring: { readonly interval: string } | null` and `readonly active: boolean`; a new `Difference` member `{ kind: "price_shape_mismatch", lookupKey, field, catalogValue, stripeValue }`.

**Why this task exists:** the comparator checks amounts and tax behaviour only. That is safe while the console can merely edit — those fields cannot change underneath it. The moment Plan 2 lets it CREATE, a Price minted against the wrong Product or a monthly interval converges to `clean` and stays there, permanently and invisibly.

- [ ] **Step 1: Write the failing test**

```ts
it("reports a monthly lookup key whose Stripe price renews annually", () => {
  const report = compareCatalogToStripe(
    [amount("mark8ly_pro_monthly_developed_v1", "usd", 10_700)],
    [price({
      lookup_key: "mark8ly_pro_monthly_developed_v1",
      currency: "usd",
      unit_amount: 10_700,
      recurring: { interval: "year" },   // WRONG: the key says monthly
    })],
  );
  expect(report.differences).toHaveLength(1);
  const d = report.differences[0];
  if (d.kind !== "price_shape_mismatch") expect.unreachable("expected a shape mismatch");
  else {
    expect(d.field).toBe("interval");
    expect(d.catalogValue).toBe("month");
    expect(d.stripeValue).toBe("year");
  }
});

it("reports an archived price as a shape mismatch, not as missing", () => {
  // `active: false` is a different fact from "absent", and conflating them
  // would tell an operator to create a price that already exists.
  const report = compareCatalogToStripe(
    [amount("mark8ly_pro_monthly_developed_v1", "usd", 10_700)],
    [price({ lookup_key: "mark8ly_pro_monthly_developed_v1", currency: "usd", unit_amount: 10_700, active: false })],
  );
  expect(report.differences.map((d) => d.kind)).toEqual(["price_shape_mismatch"]);
});

it("reports a price attached to the wrong product", () => {
  const report = compareCatalogToStripe(
    [amount("mark8ly_pro_monthly_developed_v1", "usd", 10_700)],
    [price({ lookup_key: "mark8ly_pro_monthly_developed_v1", currency: "usd", unit_amount: 10_700, product: "prod_starter" })],
    MARK8LY_LOOKUP_KEY_PREFIX,
    policyFor("mark8ly"),
    { pro: "prod_pro", starter: "prod_starter", studio: "prod_studio" },
  );
  expect(report.differences.map((d) => d.kind)).toEqual(["price_shape_mismatch"]);
});

it("says nothing about product when no product map is supplied", () => {
  // The map comes from a Stripe lookup the caller may not have made. Absent,
  // the check is skipped rather than guessed — a wrong product finding is
  // worse than no product finding.
  const report = compareCatalogToStripe(
    [amount("mark8ly_pro_monthly_developed_v1", "usd", 10_700)],
    [price({ lookup_key: "mark8ly_pro_monthly_developed_v1", currency: "usd", unit_amount: 10_700, product: "prod_anything" })],
  );
  expect(report.differences).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/parity`
Expected: FAIL — `price_shape_mismatch` is not a member of `Difference`; `recurring` and `active` are not on `StripePriceLike`.

- [ ] **Step 3: Widen the type and the reader**

In `parity.ts`:

```ts
export interface StripePriceLike {
  readonly id: string;
  readonly lookup_key: string | null;
  readonly currency: string;
  readonly unit_amount: number | null;
  readonly tax_behavior: TaxBehavior | null;
  /** Stripe's Product id. Needed once the console can CREATE a price: one
   *  minted against the wrong product agrees on every amount and is still
   *  wrong. */
  readonly active?: boolean;
  readonly product?: string | null;
  readonly recurring?: { readonly interval: string } | null;
  readonly currency_options?: {
    readonly [currency: string]: {
      readonly unit_amount: number | null;
      readonly tax_behavior: TaxBehavior | null;
    };
  };
}

/** Same key, right amounts, wrong object. */
export interface ShapeDifference {
  readonly kind: "price_shape_mismatch";
  readonly lookupKey: string;
  readonly field: "interval" | "active" | "product";
  readonly catalogValue: string;
  readonly stripeValue: string;
}
```

Add `ShapeDifference` to the `Difference` union and give it a `KIND_ORDER` rank of `5`.

Derive the expected interval from the lookup key's period segment, which is the same two-case rule `mark8ly/services/marketplace-api/internal/billing/stripe/price.go:53-55` applies:

```ts
/** `annual` -> `year`, everything else -> `month`. Mirrors mark8ly's own
 *  derivation; there is no third period in the catalog. */
function expectedInterval(lookupKey: string): "year" | "month" {
  return lookupKey.includes("_annual_") ? "year" : "month";
}
```

In `stripe-read.ts`, request the fields — Stripe returns `active`, `product` and `recurring` by default on a Price, so no new `expand` is needed, but the local type must stop discarding them.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/billing/parity`
Expected: PASS — the 4 new tests plus the existing 24.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/billing/parity.ts apps/console/lib/billing/stripe-read.ts apps/console/lib/billing/parity.test.ts
git commit -m "feat(console): the comparator checks interval, product and active"
```

---

### Task 4: Mode- and publication-aware catalog reads

**Files:**
- Modify: `apps/console/lib/db/plan-catalog-repo.ts`
- Test: `apps/console/lib/db/plan-catalog-repo.test.ts`, `apps/console/lib/db/plan-catalog-revisions.integration.test.ts`

**Interfaces:**
- Consumes: `StripeMode` from `stripe-read.ts`; tables from Task 1.
- Produces: `readCatalogAmounts(mode: StripeMode): Promise<CatalogAmount[]>`, `readLivePublication(mode: StripeMode): Promise<{ id: string; revisionId: string } | null>`; `ParityRun` gains `readonly publicationId: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
it("reads only the revision published to the requested mode", async () => {
  // The bug this prevents: without the filter, a draft's rows join the
  // published ones, lookup keys duplicate, and the comparator's grouping
  // merges two catalogs into one — the same class of silent false positive
  // that 0032's tax_behavior normalisation was written to avoid.
  const published = await insertRevision("published");
  const draft = await insertRevision("draft");
  await insertPriceWithAmount(published, "mark8ly_a_v1", "usd", 1000);
  await insertPriceWithAmount(draft, "mark8ly_a_v1", "usd", 9999);
  await publish("test", published);

  const rows = await readCatalogAmounts("test");
  expect(rows).toHaveLength(1);
  expect(rows[0].unitAmountMinor).toBe(1000);
});

it("returns nothing for a mode with no publication", async () => {
  // This is what `not_bootstrapped` is derived from. An empty read here must
  // not throw — live has never been published and that is a normal state.
  await expect(readCatalogAmounts("live")).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/db/plan-catalog`
Expected: FAIL — `readCatalogAmounts` takes 0 arguments.

- [ ] **Step 3: Implement**

```ts
export async function readCatalogAmounts(mode: StripeMode): Promise<CatalogAmount[]> {
  // Joined through the live publication rather than filtered by a status
  // column: publication is a fact about a (mode, revision) pair, and test is
  // routinely ahead of live.
  const { rows } = await tesserixQuery<CatalogAmountRow>(
    `SELECT p.lookup_key, a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_publications pub
       JOIN plan_catalog_prices  p ON p.revision_id = pub.revision_id
       JOIN plan_catalog_amounts a ON a.price_id = p.id
      WHERE pub.mode = $1 AND pub.superseded_at IS NULL
      ORDER BY p.lookup_key, a.currency`,
    [mode],
  );
  return rows.map(toCatalogAmount);
}
```

`readLivePublication` is the same `WHERE`, selecting `pub.id, pub.revision_id`, returning `null` on no rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/db/plan-catalog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/db/plan-catalog-repo.ts apps/console/lib/db/plan-catalog-repo.test.ts apps/console/lib/db/plan-catalog-revisions.integration.test.ts
git commit -m "feat(console): read the catalog through the mode's live publication"
```

---

### Task 5: Carry the publication through a parity run

**Files:**
- Modify: `apps/console/lib/billing/parity-run.ts`, `apps/console/lib/db/plan-catalog-repo.ts`, `apps/console/scripts/parity-check.ts`, `apps/console/app/api/internal/parity-check/route.ts`
- Test: `apps/console/lib/billing/parity-run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("records which publication the run was clean against", async () => {
  // A `clean` row is evidence in a 7-day window that gates a key revocation.
  // Without this, a row from three days ago cannot say WHICH catalog it
  // agreed with, and republishing invalidates it silently.
  const run = await performParityCheck("test");
  expect(run.publicationId).toBe(KNOWN_TEST_PUBLICATION_ID);
});

it("records a null publication when the mode has never been published", async () => {
  const run = await performParityCheck("live");
  expect(run.outcome).toBe("not_bootstrapped");
  expect(run.publicationId).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/parity-run`
Expected: FAIL — `publicationId` is not a property of `ParityRun`.

- [ ] **Step 3: Implement**

`performParityCheck(mode)` calls `readLivePublication(mode)` first, passes `mode` to `readCatalogAmounts`, and puts the publication id on the returned `ParityRun`. `recordParityRun` writes the new column.

- [ ] **Step 4: Run the whole console suite**

Run: `pnpm --filter console exec vitest run`
Expected: PASS. Rebuild `console-core` first.

- [ ] **Step 5: Build**

Run: `pnpm --filter console build` and `pnpm --filter console build:cron`
Expected: `next build` succeeds; the cron bundle still keeps `pg` external and `stripe` inlined.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(console): parity runs record the publication they checked"
```

---

## What Plan 1 deliberately does NOT do

- No Stripe writes. No write client, no write key, no publish path. The read client keeps its restricted key.
- No draft editing UI.
- No plan builder, guards, operation log or orphan detection — those need the write path to mean anything, and they are **Plan 2**.
- No `billing-bootstrap` retirement, and no change to `catalog.go`, which has three runtime readers (spec §10).

## Definition of done

- `0035` applied to prod before the PR merges.
- The parity check runs against the published revision for a mode, and records which publication it checked.
- A second product's catalog could be inserted without schema change, and would not be silently scaled by mark8ly's ×100 convention.
- The comparator reports a wrong interval, a wrong product and an archived price — so that when Plan 2 can create prices, "clean" means Stripe matches desired state.
