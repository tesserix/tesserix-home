// `server-only`: this module's I/O half (`runBootstrap`) reaches `pg` (through
// `plan-catalog-repo`) and `stripe` (through `stripe-read` and `stripe-write`).
// Carried here for the same reason `parity-run.ts` carries it despite most of
// its own logic living in a pure function it composes — a client component
// that reaches either transitive dependency must fail the build with the
// import chain named, not with `Can't resolve 'net'` from somewhere inside a
// driver.
import "server-only";

import {
  MARK8LY_LOOKUP_KEY_PREFIX,
  expectedInterval,
  planOf,
  type CatalogAmount,
  type StripePriceLike,
  type TaxBehavior,
} from "./parity";
import { policyFor, SINGLE_SOURCE, toStripeUnitAmount } from "./source-policy";
import { stripePriceReader, type StripeMode } from "./stripe-read";
import { stripeCatalogWriter } from "./mark8ly/stripe-write";
import { readCatalogAmounts } from "@/lib/db/plan-catalog-repo";

/**
 * Populate an EMPTY Stripe mode from the console's catalog: one Product per
 * plan, one Price per `lookup_key`.
 *
 * # Why this exists
 *
 * `lib/billing/parity.ts` can only ever REPORT a mode that has nothing in it
 * as `not_bootstrapped` (see `plan-catalog-repo.ts`'s `readCatalogAmounts`
 * doc and `parity-run.ts`'s zero-price branch) — the observation window
 * #326 built cannot start on a mode with zero Prices, because 42
 * `price_missing_in_stripe` findings every night trains everyone to ignore
 * the report. This module is what puts the first 42 Prices there so the
 * window has something to observe.
 *
 * # `planBootstrap` is pure, `runBootstrap` is not, and that split is load
 * bearing
 *
 * `planBootstrap` takes the catalog and whatever Stripe already has, and
 * decides what to create — no I/O, no `stripe` import, so a future review or
 * a future case in the 42-key shape can be proven against a fixture rather
 * than a live account. `runBootstrap` is the thin caller: it reads, calls
 * `planBootstrap`, refuses a populated mode, and creates Products before
 * Prices. Mirrors the `parity.ts` / `parity-run.ts` split exactly, for the
 * same reason.
 *
 * # No operation log, no resumability, no drafts — on purpose
 *
 * A bootstrap only ever needs to run against an EMPTY mode (the guard in
 * `runBootstrap` enforces this), and Stripe enforces `lookup_key` uniqueness
 * among ACTIVE Prices. So the second run of this same code against a
 * partially-populated mode (with `force: true`) finds what the first run
 * created and skips it, for free — `planBootstrap`'s "already fully
 * populated -> empty plan" test is exactly this convergence property. There
 * is nothing here to resume because there is nothing that can be left
 * half-done in a way this code cannot already recover from by being run
 * again.
 */

/**
 * The console's own idempotency-key namespace, distinct from mark8ly's own
 * bootstrap (`price:v3:<key>`, `product:<plan>` — see `mark8ly/stripe-write.ts`).
 *
 * The Stripe account this runs against may already hold mark8ly's own
 * idempotency keys from its own bootstrap tool, including a CACHED ERROR
 * response for one of them. Reusing that literal key would replay whatever
 * Stripe cached under it — invisibly, because a cached idempotent response
 * looks exactly like success. A key namespaced to this codepath can only ever
 * collide with a run of this same code.
 *
 * That protection is NOT free of the same property it protects against,
 * inherited rather than avoided: these keys carry no run-scoped component
 * (no timestamp, no attempt counter), so Stripe's own 24-hour idempotency
 * cache applies to THEM too. A Price rejected with a 4xx, then fixed and
 * re-run within that window, replays the cached 4xx rather than retrying —
 * but that failure is LOUD (the run reports it, non-zero exit, per-mode log
 * line), never silent, which is the distinction that matters: a cached
 * SUCCESS masquerading as a fresh one is invisible; a cached ERROR blocking a
 * fix is merely confusing until someone reads this comment. The escape hatch
 * is bumping the version segment — `console:bootstrap:v2` — which mints a
 * whole new key space and forgets everything Stripe cached under `v1`.
 */
const IDEMPOTENCY_PREFIX = "console:bootstrap:v1";

function productIdempotencyKey(plan: string): string {
  return `${IDEMPOTENCY_PREFIX}:product:${plan}`;
}

function priceIdempotencyKey(lookupKey: string): string {
  return `${IDEMPOTENCY_PREFIX}:price:${lookupKey}`;
}

/** One currency's amount and tax behaviour, already converted to Stripe's
 *  minor-unit convention — see {@link planBootstrap}'s use of
 *  `toStripeUnitAmount`. */
interface PlannedCurrencyOption {
  readonly unitAmount: number;
  readonly taxBehavior: TaxBehavior;
}

/**
 * One `lookup_key` this plan wants to create.
 *
 * Carries `plan`, NOT `productId` — planning happens before any Product
 * exists, `runBootstrap` composes the `productId` in after it has upserted
 * the plan's Product. See the module header.
 */
export interface BootstrapPlanPrice {
  readonly plan: string;
  readonly lookupKey: string;
  /** The Price's own (baseline) currency — `usd` for a `developed`
   *  descriptor, the sole PPP currency otherwise. See
   *  {@link baselineCurrencyOf}. */
  readonly currency: string;
  readonly unitAmount: number;
  readonly period: "monthly" | "annual";
  readonly taxBehavior: TaxBehavior;
  /**
   * Every OTHER currency this Price should cover — the baseline is
   * deliberately excluded, matching `CreatePriceSpec.currencyOptions`'
   * contract in `mark8ly/stripe-write.ts`: Stripe rejects a create call whose
   * baseline currency also appears here. A `developed` descriptor holds six
   * entries (its six non-`usd` currencies); a PPP descriptor holds none, since
   * its one currency IS the baseline.
   */
  readonly currencyOptions: Readonly<Record<string, PlannedCurrencyOption>>;
}

/** What `planBootstrap` decided needs creating. */
export interface BootstrapPlan {
  /** Distinct plan names with at least one Price still to create — NOT every
   *  plan the catalog has. `runBootstrap` still does a find-or-create against
   *  each of these, because a Product from a prior (partial or `force`d) run
   *  may already exist; this list only says which plans this run needs a
   *  Product id for at all. */
  readonly products: readonly string[];
  readonly prices: readonly BootstrapPlanPrice[];
}

/**
 * `annual` -> `annual`, `monthly` -> `monthly` — composed from `parity.ts`'s
 * `expectedInterval`, which is the ONE place the `_annual_`/`_monthly_`
 * substring rule lives. `expectedInterval` answers a different question
 * ("year" | "month", Stripe's `recurring.interval` value), and
 * `mark8ly/stripe-write.ts`'s `intervalOf` already owns turning a
 * `CreatePriceSpec.period` back into that — so the RETURNED VALUES differ on
 * both sides of this function. The underlying substring rule does not: it is
 * read here through `expectedInterval`, never re-tested against the key a
 * second time. Two independent copies of that rule is exactly the drift
 * `expectedInterval`'s own comment warns about — the next person to correct
 * one of them would leave the other disagreeing, silently, about what
 * `annual` means.
 *
 * The explicit check below THROWS on an unrecognised key rather than
 * reaching `expectedInterval`'s own default, and that is a deliberate layer
 * ON TOP of the shared rule, not a second copy of it: `expectedInterval`'s
 * silent "month" default exists for a COMPARATOR reading what a live Price
 * already has, where an unrecognised key becomes a visible finding a human
 * reviews. This function is about to CREATE a Price with a specific billing
 * cadence — guessing `monthly` for a key that is neither would create a
 * Price nobody asked for, so the unrecognised case is refused here, before
 * `expectedInterval` ever gets a chance to default it away.
 */
function periodOf(lookupKey: string): "monthly" | "annual" {
  if (!lookupKey.includes("_annual_") && !lookupKey.includes("_monthly_")) {
    throw new Error(
      `bootstrap: "${lookupKey}" contains neither "_annual_" nor "_monthly_"; cannot decide its billing period`,
    );
  }
  return expectedInterval(lookupKey) === "year" ? "annual" : "monthly";
}

/**
 * The baseline currency for one `lookup_key`'s group of catalog amounts.
 *
 * `usd` for a `developed` descriptor, the group's own single currency for a
 * PPP one — but ASSERTED against the group's actual rows, not merely read off
 * the `_developed_` / `_ppp_` segment. A wrong baseline creates a Price that
 * agrees on nothing with the catalog it was meant to mirror, so a shape that
 * contradicts the rule fails loudly here rather than guessing.
 */
function baselineCurrencyOf(lookupKey: string, currencies: readonly string[]): string {
  if (lookupKey.includes("_developed_")) {
    // All six `developed` descriptors carry `usd` — verified against
    // `0032_plan_catalog.sql`'s seed. If a future one does not, guessing
    // `usd` anyway would create a Price whose baseline the catalog never
    // priced.
    if (!currencies.includes("usd")) {
      throw new Error(
        `bootstrap: "${lookupKey}" is a developed descriptor but its catalog amounts do not include usd`,
      );
    }
    return "usd";
  }

  // Every non-`developed` key in the catalog today is a PPP descriptor with
  // exactly one currency, which IS its baseline. More than one contradicts
  // that shape outright; guessing which of several to treat as the baseline
  // would be worse than refusing.
  if (currencies.length !== 1) {
    throw new Error(
      `bootstrap: "${lookupKey}" is not a developed descriptor and must carry exactly one currency ` +
        `(its PPP baseline); got ${currencies.length}: ${currencies.join(", ")}`,
    );
  }
  return currencies[0];
}

/**
 * Decide what a bootstrap of `mode` needs to create — no I/O.
 *
 * `catalog` is every amount the console intends to publish (78 rows across 42
 * keys, in production); `existing` is whatever Stripe already reports for
 * that mode (`stripePriceReader.listPrices(mode)`'s result, in production).
 * Grouped by `lookup_key`, one Stripe Price per group — a per-amount plan
 * would create 78 Prices and break every lookup-key assumption `parity.ts`
 * makes (a `developed` descriptor is ONE Price carrying seven currencies).
 *
 * Every amount is converted through {@link toStripeUnitAmount} with
 * `policyFor(SINGLE_SOURCE)` before it reaches the returned plan —
 * `CatalogAmount` carries no `source` (see `plan-catalog-repo.ts`'s note on
 * the same single-source assumption), so this hard-codes mark8ly's policy at
 * the boundary exactly the way `parity.ts`'s `compareCatalogToStripe`
 * defaults to it. Skipping this sends every VND price 100x wrong, live, on
 * the write side — the read-side version of this bug was found in the
 * comparator on 2026-08-27.
 */
export function planBootstrap(
  catalog: readonly CatalogAmount[],
  existing: readonly StripePriceLike[],
): BootstrapPlan {
  const existingKeys = new Set<string>();
  for (const p of existing) {
    if (p.lookup_key && p.lookup_key.startsWith(MARK8LY_LOOKUP_KEY_PREFIX)) {
      existingKeys.add(p.lookup_key);
    }
  }

  const byKey = new Map<string, CatalogAmount[]>();
  for (const row of catalog) {
    let group = byKey.get(row.lookupKey);
    if (!group) {
      group = [];
      byKey.set(row.lookupKey, group);
    }
    group.push(row);
  }

  const policy = policyFor(SINGLE_SOURCE);
  const plans = new Set<string>();
  const prices: BootstrapPlanPrice[] = [];

  // Deterministic iteration order (Map preserves insertion order; the
  // catalog read is itself ordered by `lookup_key` — see
  // `plan-catalog-repo.ts`) so the plan is the same between runs and a test
  // asserting call ORDER against a mock isn't asserting against a coin flip.
  for (const [lookupKey, rows] of byKey) {
    if (existingKeys.has(lookupKey)) continue;

    const plan = planOf(lookupKey, MARK8LY_LOOKUP_KEY_PREFIX);
    const period = periodOf(lookupKey);
    const baseline = baselineCurrencyOf(
      lookupKey,
      rows.map((r) => r.currency),
    );

    let baselineOption: PlannedCurrencyOption | null = null;
    const currencyOptions: Record<string, PlannedCurrencyOption> = {};
    for (const row of rows) {
      const converted: PlannedCurrencyOption = {
        unitAmount: toStripeUnitAmount(row.currency, row.unitAmountMinor, policy),
        taxBehavior: row.taxBehavior,
      };
      if (row.currency === baseline) {
        baselineOption = converted;
      } else {
        currencyOptions[row.currency] = converted;
      }
    }

    // Unreachable given `baselineCurrencyOf`'s own asserts above (the
    // baseline it returns always came from `rows`), but the non-null
    // assertion below would otherwise be exactly the kind of silent trust
    // this module's header argues against.
    if (!baselineOption) {
      throw new Error(`bootstrap: "${lookupKey}" resolved a baseline currency "${baseline}" with no matching row`);
    }

    plans.add(plan);
    prices.push({
      plan,
      lookupKey,
      currency: baseline,
      unitAmount: baselineOption.unitAmount,
      period,
      taxBehavior: baselineOption.taxBehavior,
      currencyOptions,
    });
  }

  return { products: [...plans].sort(), prices };
}

/** `runBootstrap`'s knobs. */
export interface BootstrapOptions {
  /**
   * Proceed even though `mode` already holds `mark8ly_` Prices.
   *
   * Absent this, `runBootstrap` refuses outright — see its doc. The only
   * legitimate reason to pass `true` is re-running against a mode this same
   * tool already partially or fully populated, which `planBootstrap`'s
   * convergence property makes safe.
   */
  readonly force?: boolean;

  /**
   * Do every read and the same plan computation a real run does, then return
   * without calling `stripeCatalogWriter.createProduct` or `.createPrice` —
   * see `scripts/catalog-bootstrap.ts`'s `--dry-run`.
   *
   * Also bypasses the populated-mode guard below, `force` or not: the
   * question a dry run answers is "what would a (forced, if needed) run do
   * against this mode right now", not "is this mode allowed to run for
   * real". An operator rehearsing against the live mode before the first
   * bootstrap (#396) should never have to pass `--force` just to see the
   * report — that flag is for authorising a WRITE, and a dry run makes none.
   */
  readonly dryRun?: boolean;
}

/** What one `runBootstrap` call did, by kind — the whole deliverable an
 *  operator reads off the CLI's log line (see `scripts/catalog-bootstrap.ts`). */
export interface BootstrapResult {
  readonly productsCreated: number;
  readonly pricesCreated: number;
  /** Catalog keys `planBootstrap` left out of the plan because Stripe already
   *  had them — the count that turns "42 keys, 0 created" into a legible
   *  "already done" rather than a silent no-op. */
  readonly skipped: number;
}

/**
 * Populate `mode` from the catalog: read, plan, refuse a populated mode
 * without `force`, then create every planned Product before any planned
 * Price.
 *
 * # The guard reads Stripe, not a caller's claim
 *
 * The count that decides whether this refuses comes from
 * `stripePriceReader.listPrices(mode)` — a live read, filtered to
 * {@link MARK8LY_LOOKUP_KEY_PREFIX} so a shared account holding unrelated
 * Prices cannot refuse forever. There is deliberately no way for a caller to
 * assert "the mode has N prices" and have that substituted for what Stripe
 * actually reports: an injected count would let a caller lie about the
 * account's state, which is exactly the mistake this guard exists to catch
 * — this estate has already made it once, with an `rk_live_` key read as the
 * wrong mode's credential (see `stripe-read.ts`).
 *
 * # Products before Prices
 *
 * Every planned Product is found-or-created first, building a plan-name ->
 * Stripe-Product-id map; only then does any Price get created, each
 * referencing that map. A Price minted before its Product exists is not an
 * operation Stripe accepts, and creating them in the other order would also
 * make a partial failure harder to reason about — a Price can only ever be
 * missing its Product, never point at a phantom one.
 */
export async function runBootstrap(
  mode: StripeMode,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  // Sequential, not `Promise.all` — mirrors `performParityCheck`
  // (`parity-run.ts`): a catalog read that fails should not also spend a
  // Stripe request, and a thrown error names which side broke rather than
  // arriving as one of two racing rejections.
  //
  // SINGLE-SOURCE ASSUMPTION: `SINGLE_SOURCE` (`source-policy.ts`) is every
  // row `plan_catalog_prices` holds today, and this bootstrap only ever
  // populates that source's own Stripe namespace (`MARK8LY_LOOKUP_KEY_PREFIX`,
  // below). See #381's follow-up for what a second source needs before this
  // can stop being hard-coded.
  const catalog = await readCatalogAmounts(mode, SINGLE_SOURCE);

  // Mirrors `performParityCheck`'s (`parity-run.ts:150-161`) refusal to call
  // an empty catalog against an empty Stripe "clean": `readCatalogAmounts`
  // returns `[]` both when the catalog is genuinely empty AND when `mode` has
  // no un-superseded publication yet (`plan-catalog-repo.ts`'s `WHERE pub.mode
  // = $1 AND pub.superseded_at IS NULL`) — live is in exactly that state as of
  // this writing, since the catalog has never been published there. Without
  // this check, that read's own silence would make `runBootstrap` plan
  // nothing and report `{productsCreated: 0, pricesCreated: 0, skipped: 0}`
  // with no thrown error — a zero-filled "ok" line that is indistinguishable,
  // to whoever reads it, from a bootstrap that had nothing left to do. The
  // read side refuses to call that state `clean`; the write side refuses to
  // call it `ok`, for the same reason.
  if (catalog.length === 0) {
    throw new Error(
      `bootstrap: ${mode} mode's catalog read returned no amounts — most likely no publication has ` +
        `reached ${mode} yet (see plan_catalog_publications); refusing to report success against nothing`,
    );
  }

  const existing = await stripePriceReader.listPrices(mode);

  const existingCount = existing.filter(
    (p) => p.lookup_key && p.lookup_key.startsWith(MARK8LY_LOOKUP_KEY_PREFIX),
  ).length;

  if (existingCount > 0 && !opts.force && !opts.dryRun) {
    throw new Error(
      `bootstrap: ${mode} mode already holds ${existingCount} mark8ly_ price(s); refusing to run without force`,
    );
  }

  const plan = planBootstrap(catalog, existing);

  const distinctCatalogKeys = new Set(catalog.map((row) => row.lookupKey)).size;
  const skipped = distinctCatalogKeys - plan.prices.length;

  if (opts.dryRun) {
    // The same found-or-create DECISION the real loop below makes, but only
    // its read half (`findProductByPlan`, never `createProduct`) — so
    // `productsCreated` here means what it means in a real `BootstrapResult`:
    // products this run would actually mint, not merely plans the computed
    // `plan` mentions. A plan name can already have a Product from a prior
    // partial or forced run; reporting `plan.products.length` unconditionally
    // would overstate a dry run against exactly that mode.
    let productsToCreate = 0;
    for (const planName of plan.products) {
      const found = await stripeCatalogWriter.findProductByPlan(mode, planName, SINGLE_SOURCE);
      if (!found) productsToCreate += 1;
    }
    return { productsCreated: productsToCreate, pricesCreated: plan.prices.length, skipped };
  }

  const productIds = new Map<string, string>();
  let productsCreated = 0;
  for (const planName of plan.products) {
    const found = await stripeCatalogWriter.findProductByPlan(mode, planName, SINGLE_SOURCE);
    if (found) {
      productIds.set(planName, found.id);
      continue;
    }
    const created = await stripeCatalogWriter.createProduct(mode, planName, SINGLE_SOURCE, productIdempotencyKey(planName));
    productIds.set(planName, created.id);
    productsCreated += 1;
  }

  for (const priceSpec of plan.prices) {
    const productId = productIds.get(priceSpec.plan);
    if (!productId) {
      // Cannot happen given `plan.products` is derived from the same
      // `plan.prices` this loop iterates — every plan name a price needs was
      // resolved to a Product id above. Thrown rather than assumed, because a
      // Price minted with no Product reference is worse than a run that stops.
      throw new Error(
        `bootstrap: no product id resolved for plan "${priceSpec.plan}" before creating price "${priceSpec.lookupKey}"`,
      );
    }
    await stripeCatalogWriter.createPrice(mode, {
      productId,
      lookupKey: priceSpec.lookupKey,
      currency: priceSpec.currency,
      unitAmount: priceSpec.unitAmount,
      period: priceSpec.period,
      taxBehavior: priceSpec.taxBehavior,
      currencyOptions: priceSpec.currencyOptions,
      idempotencyKey: priceIdempotencyKey(priceSpec.lookupKey),
    });
  }

  return { productsCreated, pricesCreated: plan.prices.length, skipped };
}
