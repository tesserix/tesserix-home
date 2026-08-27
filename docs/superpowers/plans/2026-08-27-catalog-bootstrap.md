# Catalog Bootstrap — populate a Stripe mode from the console's catalog

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the console create the products and prices a Stripe mode is missing, so live can be populated without a write key ever leaving managed storage — and so the parity check can report `clean` on both modes, which is what starts #327's observation window.

**Architecture:** A write client with four methods and its own per-mode credential, plus a runner that creates only what is absent. No drafts, no revisions, no guards, no operation log — a bootstrap converges an empty account and has nothing to diff against and nothing to resume.

**Tech Stack:** TypeScript, Node, `stripe` v22, vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-console-catalog-authoring-design.md`

## Why this exists separately from Plan 2

`billing-bootstrap` in mark8ly already does this job and is mode-agnostic, so the
cheapest possible path is to run it with a live key and build nothing. **The only
reason not to is where the key ends up:** running the CLI puts a live Stripe
write key on a workstation. Doing it from the console keeps it in Secret Manager
and the cluster.

That is the whole argument. If that trade does not persuade, run the CLI and
close this plan — the work here is a subset of Plan 2 and loses nothing by being
skipped.

**What this deliberately does NOT build**, and why each is unnecessary for a
bootstrap specifically:

- **No draft/revision editing.** There is nothing to edit; the catalog already
  holds what the mode should contain.
- **No three-way plan.** A three-way diff separates intent from drift. An empty
  account has no drift, and no ancestor to compare against.
- **No guards.** Magnitude and breadth guards compare a change against prior
  intent. Creating 42 prices where none exist is not a change, and a breadth
  guard would fire on every run by design.
- **No operation log or resumability.** Re-running is safe by construction:
  `lookup_key` is unique among ACTIVE prices, so a second run finds what the
  first created and skips it. That is exactly how `billing-bootstrap` gets away
  with 60 lines.

All of those become necessary the moment the console can *change* an existing
price. That is Plan 2.

## Global Constraints

- **Plan 1 must be merged** — this consumes `readCatalogAmounts(mode)` and
  `StripeMode`. It is (PR #380, `dfeaa33`).
- **The experiments in spec §0 are binding.** Two of them changed the operation
  model after Plan 2 was drafted: `currency_options` MERGES, and an existing
  currency's amount is IMMUTABLE. This plan only creates, so it is unaffected —
  but the write client it produces is the one Plan 2 inherits, so its shape must
  match the corrected model.
- **Every amount sent to Stripe passes through `toStripeUnitAmount`** with the
  source's policy. Skipping it sends every VND price 100× wrong.
- **The baseline currency must be filtered out of `currency_options`.** Stripe
  rejects a create whose `currency_options` contains the top-level currency —
  the failure that stuck a mark8ly bootstrap run and is why its idempotency key
  is at `v3`.
- pnpm workspace; `npm ci` FAILS. Scope vitest: `pnpm --filter console exec vitest run <path>`.
- TDD. No live Stripe calls in tests — the SDK is mocked.
- Comment register: WHY, and what breaks otherwise.

---

## File Structure

| file | responsibility |
|---|---|
| `apps/console/lib/billing/mark8ly/stripe-write.ts` | the ONLY module that can write to Stripe |
| `apps/console/lib/billing/bootstrap.ts` | decide what is missing; create it (pure decision + thin caller) |
| `apps/console/scripts/catalog-bootstrap.ts` | the runnable entry point |

---

### Task A: The write client

**Files:**
- Create: `apps/console/lib/billing/mark8ly/stripe-write.ts`, `stripe-write.test.ts`

**Interfaces:**
- Produces: `stripeCatalogWriter` with `findProductByPlan(mode, plan)`, `createProduct(mode, plan)`, `createPrice(mode, spec)`, `addCurrencyOption(mode, priceId, currency, unitAmount, idempotencyKey)`. `WRITE_KEY_ENV: Record<StripeMode, string>`. `StripeWriteUnavailableError`.

**Note on shape:** Plan 2's draft named an `updatePriceCurrencyOptions` method. **That method cannot exist** — spec §1.6a: an existing currency's amount is immutable. `addCurrencyOption` replaces it and covers the only in-place amount write Stripe permits.

- [ ] **Step 1: Write the failing test**

```ts
it("exposes exactly four methods, named individually so this fails on the next change", () => {
  expect(Object.keys(stripeCatalogWriter).sort()).toEqual([
    "addCurrencyOption", "createPrice", "createProduct", "findProductByPlan",
  ]);
});

it("never returns the underlying Stripe instance", () => {
  for (const v of Object.values(stripeCatalogWriter)) expect(typeof v).toBe("function");
});

it("fails clearly when the mode's key is absent", async () => {
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", "");
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro"))
    .rejects.toThrow(/STRIPE_WRITE_KEY_TEST/);
});

it("refuses a key whose prefix contradicts its mode", async () => {
  // The read-side version of this mistake cost an hour on 2026-08-27 and
  // produced a report claiming all 42 prices were missing. The WRITE-side
  // version creates 42 prices in the wrong account.
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", ["sk", "live", "abc123"].join("_"));
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro"))
    .rejects.toThrow(/mode/i);
});

it("finds an existing product by metadata.plan rather than a stored id", async () => {
  // mark8ly's own design: CreateProduct sets metadata[plan] "so subsequent
  // FindProductByMetadata lookups succeed without storing the Stripe ID
  // locally". The catalog holds `plan`; it holds no product id.
  await stripeCatalogWriter.findProductByPlan("test", "pro");
  expect(listed).toMatchObject({ active: true });
});

it("never puts the baseline currency inside currency_options", async () => {
  // Stripe REJECTS the call outright. This exact rejection stuck a mark8ly
  // bootstrap run and is why its idempotency key is at v3.
  await stripeCatalogWriter.createPrice("test", {
    productId: "prod_x", lookupKey: "k", currency: "usd", unitAmount: 100,
    interval: "month", taxBehavior: "unspecified",
    currencyOptions: { usd: 100, gbp: 90 }, idempotencyKey: "k1",
  });
  expect(Object.keys(created.currency_options)).toEqual(["gbp"]);
});

it("derives the interval from the period, not from a stored field", async () => {
  // `annual` -> `year`, else `month`. Mirrors mark8ly's price.go:53-55.
  await stripeCatalogWriter.createPrice("test", { /* ...period annual... */ });
  expect(created.recurring.interval).toBe("year");
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

/** A key for the wrong mode is refused rather than used. On the write side the
 *  wrong account means objects created in it. */
const EXPECTED_PREFIX: Record<StripeMode, readonly string[]> = {
  test: ["sk_test_", "rk_test_"],
  live: ["sk_live_", "rk_live_"],
};

// Module-private and NEVER returned. Returning it hands every caller the full
// write API and makes the four-method surface decorative.
const clients = new Map<string, Stripe>();
```

`createPrice` filters the baseline out of `currencyOptions`, derives `interval`
from `period`, and passes `idempotencyKey` as a Stripe request option.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/billing/mark8ly/stripe-write`
Expected: PASS, 7 tests. No live Stripe call — `vi.mock("stripe")`.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/billing/mark8ly/
git commit -m "feat(console): a Stripe write client with four methods and no instance escape"
```

---

### Task B: The bootstrap runner

**Files:**
- Create: `apps/console/lib/billing/bootstrap.ts`, `bootstrap.test.ts`
- Create: `apps/console/scripts/catalog-bootstrap.ts`, `catalog-bootstrap.test.ts`

**Interfaces:**
- Consumes: `readCatalogAmounts(mode)` (Plan 1), `stripePriceReader.listPrices(mode)`, `stripeCatalogWriter` (Task A), `policyFor`/`toStripeUnitAmount` (Plan 1).
- Produces: `planBootstrap(catalog, existing): BootstrapPlan`, `runBootstrap(mode, opts): Promise<BootstrapResult>`.

- [ ] **Step 1: Write the failing test**

```ts
it("plans 3 products and 42 prices against an empty mode", () => {
  const plan = planBootstrap(FULL_CATALOG_78, []);
  expect(plan.products).toHaveLength(3);
  expect(plan.prices).toHaveLength(42);
});

it("skips a lookup key Stripe already has", () => {
  // Re-running is safe BY CONSTRUCTION — lookup_key is unique among ACTIVE
  // prices, so the second run finds what the first created. This is what lets
  // a bootstrap skip the operation log and resumability entirely.
  const plan = planBootstrap(FULL_CATALOG_78, [price({ lookup_key: "mark8ly_pro_annual_developed_v1" })]);
  expect(plan.prices.map((p) => p.lookupKey)).not.toContain("mark8ly_pro_annual_developed_v1");
  expect(plan.prices).toHaveLength(41);
});

it("produces an EMPTY plan when the mode is already fully populated", () => {
  // The convergence property, and the thing that makes re-running harmless.
  expect(planBootstrap(FULL_CATALOG_78, ALL_42_PRICES)).toMatchObject({ products: [], prices: [] });
});

it("groups a developed descriptor's seven currencies onto ONE price", () => {
  // 78 amounts, 42 prices. A per-amount plan would create 78 Stripe Prices and
  // break every lookup-key assumption downstream.
  const plan = planBootstrap(FULL_CATALOG_78, []);
  const dev = plan.prices.find((p) => p.lookupKey === "mark8ly_pro_annual_developed_v1")!;
  expect(Object.keys(dev.currencyOptions).length + 1).toBe(7); // +1 for the baseline
});

it("converts zero-decimal amounts before sending", () => {
  // Catalog holds VND x100. Sending it raw is the 100x defect found in the
  // comparator on 2026-08-27, on the write side where it charges people.
  const plan = planBootstrap([amount("mark8ly_pro_annual_ppp_vnd_v1", "vnd", 1_978_800_000)], []);
  expect(plan.prices[0].unitAmount).toBe(19_788_000);
});

it("refuses to run against a mode that already holds prices, unless forced", async () => {
  // A bootstrap is for an EMPTY mode. Running it against a populated one is
  // almost always a mistake about which mode you are in — and this estate has
  // already made that mistake once with an rk_live_ key.
  await expect(runBootstrap("test", { existingCount: 42 })).rejects.toThrow(/already holds/i);
  await expect(runBootstrap("test", { existingCount: 42, force: true })).resolves.toBeDefined();
});

it("creates products before the prices that reference them", async () => {
  const order = await runBootstrapRecordingOrder("test");
  expect(order.indexOf("product")).toBeLessThan(order.indexOf("price"));
});

it("reports what it created, per kind", async () => {
  const r = await runBootstrap("live", { /* empty mode */ });
  expect(r).toMatchObject({ productsCreated: 3, pricesCreated: 42, skipped: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/billing/bootstrap`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`planBootstrap` is a **pure function** — catalog rows and observed prices in, a
plan out. No I/O and no `stripe` import, so it is exhaustively fixture-testable.

It groups the 78 amounts by `lookup_key` into 42 price specs, marks the baseline
currency (`usd` for developed, the PPP currency otherwise), converts every
amount through `toStripeUnitAmount`, and drops any key Stripe already has.

`runBootstrap` reads, plans, refuses a populated mode without `force`, then
creates products first and prices second.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter console exec vitest run lib/billing/bootstrap scripts/catalog-bootstrap`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify against the rehearsal sandbox**

**Not a unit test — a real run**, against `catalog-bootstrap-rehearsal`
(`acct_1U8wRZE0e9LEcqjJ`), which exists for exactly this and holds nothing of
value.

```bash
STRIPE_WRITE_KEY_TEST=$(gcloud secrets versions access latest \
  --secret=dev-tesserix-stripe-rehearsal-write-key --project=tesseracthub-480811) \
  pnpm --filter console exec tsx scripts/catalog-bootstrap.ts --mode=test
```

Expected: 3 products, 42 prices created. Then **run it again** — expected: 0
created, 42 skipped. Then point the parity check at the same account and expect
`clean`.

That last step is the whole deliverable: it proves the console's catalog and a
freshly-bootstrapped Stripe agree, which is the claim everything downstream
rests on.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/billing/bootstrap.ts apps/console/lib/billing/bootstrap.test.ts apps/console/scripts/catalog-bootstrap.ts apps/console/scripts/catalog-bootstrap.test.ts
git commit -m "feat(console): bootstrap a Stripe mode from the catalog"
```

---

## Definition of done

- The console can populate an empty Stripe mode with 3 products and 42 prices.
- Re-running produces an empty plan and creates nothing.
- A populated mode is refused without an explicit `force`.
- Verified against a real sandbox, then verified again by the parity check
  reporting `clean`.
- No live Stripe write key has left Secret Manager.

## What has to happen outside this plan

- **A live-mode Stripe write key**, in `STRIPE_WRITE_KEY_LIVE`. This is the
  first credential in the estate that can move real money, and it is
  mark8ly#371's decision, not this plan's.
- Running the bootstrap against live, once that key exists.
- The parity check running nightly on both modes — k8s#653, which needs
  updating for the per-mode read keys.
