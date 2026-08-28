/**
 * The three-way publish plan: ancestor + draft + observed in, a typed list of
 * Stripe operations out.
 *
 * # Why three inputs, not two
 *
 * A draft-vs-observed diff alone cannot tell "what the operator changed" from
 * "what drifted underneath them on the Stripe Dashboard" — both look like the
 * same delta. Without the ancestor (the revision we last published, i.e. what
 * we last told Stripe), publishing would silently revert a Dashboard edit
 * nobody was told about, and a breadth guard downstream ("40 entries changed")
 * would be meaningless: 40 could be 40 things the operator asked for, or one
 * thing they asked for plus 39 things somebody else changed in the Dashboard
 * an hour ago. See spec §2.
 *
 * So every operation this module emits carries `origin`:
 *   - `"intended"`        — draft differs from ancestor at this cell.
 *   - `"drift-correction"` — draft agrees with ancestor, but Stripe does not.
 *
 * Both origins are PUBLISHED. Only the label differs, and the label is what
 * lets Task 4's guards refuse a plan that is mostly correcting drift nobody
 * asked about, and what lets an operator see they are about to overwrite
 * someone else's Dashboard change.
 *
 * # PURE, same discipline as parity.ts
 *
 * Three arrays in, a plan out. No I/O, no `stripe` import, not even a type
 * one — see `parity.ts`'s header for why that restriction earns its keep:
 * exhaustive fixture-testability for the function that decides what gets
 * WRITTEN to a live Stripe account, and no server ancestry to drag `stripe`
 * (a Node library) into a browser bundle.
 *
 * # The operation taxonomy, corrected after three sandbox experiments
 * (2026-08-27, spec §0 and §1.6a)
 *
 * An earlier design expected an `update_currency_options` kind covering 36 of
 * 78 amount cells: change an existing currency's amount in place. Stripe
 * refuses that outright —
 *
 *   `"You are attempting to update an immutable field for an existing
 *      currency in currency_options."`
 *
 * — so that kind cannot exist; nothing could ever execute it. What replaces
 * it:
 *
 *   - `replace_price` — ANY amount change, baseline or non-baseline currency,
 *     is a brand new Price (create + `transfer_lookup_key` + archive the old
 *     id, captured before the create per spec §1.3). This is also how a
 *     `tax_behavior` change FROM an already-set value is handled: §1.4 found
 *     that transition refused outright ("You cannot update `tax_behavior`
 *     field once it has been specified"), and §1.6a found that a
 *     currency_options entry's `tax_behavior` cannot be changed independently
 *     of its (immutable) amount either — so any currency-level tax_behavior
 *     change on a non-baseline currency also forces a replace.
 *   - `add_currency_option` — the ONE in-place amount write that survives:
 *     adding a currency the Price does not carry yet. Verified by experiment:
 *     `cad` went into a price's `currency_options` cleanly when the map
 *     didn't have it. Also verified: `currency_options` MERGES on update
 *     (§1.6), so this operation sends ONLY the new currencies — the
 *     "resend all six" mitigation an earlier draft required is withdrawn.
 *   - `update_tax_behavior` — the price's OWN `tax_behavior` (the baseline
 *     currency, not a `currency_options` entry) moving off `unspecified`.
 *     One-way, single-use per §1.4.
 *   - `create_product`, `create_price`, `archive_price` — unchanged from the
 *     brief; a Price entirely absent from Stripe, or a `lookup_key` the draft
 *     no longer wants.
 *
 * `currency_missing_in_catalog` (Stripe carries a currency the draft doesn't
 * want) and `price_shape_mismatch` (interval / active / product) diffs are
 * DELIBERATELY not turned into operations here. There is no API call that
 * removes a currency from `currency_options`, and fixing a shape mismatch
 * (wrong Product, wrong interval) needs the comparator widening spec §2
 * describes as a prerequisite for creation — out of scope for this task. See
 * the report for what that means in practice.
 */

import {
  compareCatalogToStripe,
  expectedInterval,
  planOf,
  type CatalogAmount,
  type Difference,
  type PriceDifference,
  type StripePriceLike,
  type TaxBehavior,
} from "./parity";
import { SINGLE_SOURCE, policyFor, toStripeUnitAmount, type SourcePolicy } from "./source-policy";

// Node's built-in hash, not a browser API: unlike `parity.ts`, this module's
// only real caller is the publish action, which is server-only by
// construction (it is the thing that talks to Stripe). `createHash` is a
// pure, synchronous, deterministic computation — no network, no disk — so it
// does not violate the "no I/O" rule above; it just isn't something a
// `next build` browser bundle would ever need to resolve from this file.
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// The operation union
// ---------------------------------------------------------------------------

export type OperationOrigin = "intended" | "drift-correction";

export type OperationKind =
  | "create_product"
  | "create_price"
  | "replace_price"
  | "add_currency_option"
  | "update_tax_behavior"
  | "archive_price";

/** One currency's Stripe-ready value inside a `currency_options` map. */
export interface CurrencyOptionValue {
  /**
   * ALREADY through {@link toStripeUnitAmount} — see the constraint in the
   * module header of `source-policy.ts`. An operation carrying a raw catalog
   * minor-units number would send every zero-decimal-currency amount (VND,
   * JPY, KRW, ...) 100x wrong; this is the third place in this codebase that
   * defect has had to be guarded against (the comparator, and twice in the
   * UI before this).
   */
  readonly unitAmount: number;
  readonly taxBehavior: TaxBehavior;
}

interface OperationBase {
  readonly origin: OperationOrigin;
}

export interface CreateProductOperation extends OperationBase {
  readonly kind: "create_product";
  /** `metadata.plan` the created Product resolves by — see spec's opening. */
  readonly plan: string;
}

export interface CreatePriceOperation extends OperationBase {
  readonly kind: "create_price";
  readonly lookupKey: string;
  readonly plan: string;
  readonly interval: "year" | "month";
  /** The Price's own currency (the "baseline" — always covered, map or no map). */
  readonly currency: string;
  readonly unitAmount: number;
  readonly taxBehavior: TaxBehavior;
  /** Every OTHER currency the draft wants for this key. May be empty (a `ppp` row is single-currency). */
  readonly currencyOptions: Readonly<Record<string, CurrencyOptionValue>>;
}

export interface ReplacePriceOperation extends OperationBase {
  readonly kind: "replace_price";
  readonly lookupKey: string;
  /**
   * Captured BEFORE the create, per spec §1.3: the old Price keeps
   * `active: true` and loses its `lookup_key` the instant
   * `transfer_lookup_key` runs, so resolving it by lookup key at archive time
   * would resolve to the price this operation just created.
   */
  readonly oldPriceId: string;
  readonly currency: string;
  readonly unitAmount: number;
  readonly taxBehavior: TaxBehavior;
  readonly currencyOptions: Readonly<Record<string, CurrencyOptionValue>>;
}

export interface AddCurrencyOptionOperation extends OperationBase {
  readonly kind: "add_currency_option";
  readonly lookupKey: string;
  readonly priceId: string;
  /**
   * ONLY the currencies being added. `currency_options` MERGES on update
   * (spec §1.6) — sending the whole draft row here would be harmless to
   * Stripe but would misrepresent, to anyone reading the plan, which
   * currencies are actually new.
   */
  readonly currencyOptions: Readonly<Record<string, CurrencyOptionValue>>;
}

export interface UpdateTaxBehaviorOperation extends OperationBase {
  readonly kind: "update_tax_behavior";
  readonly lookupKey: string;
  readonly priceId: string;
  /** Always a move OFF `"unspecified"` — see spec §1.4. */
  readonly taxBehavior: TaxBehavior;
}

export interface ArchivePriceOperation extends OperationBase {
  readonly kind: "archive_price";
  readonly lookupKey: string;
  readonly priceId: string;
}

export type PublishOperation =
  | CreateProductOperation
  | CreatePriceOperation
  | ReplacePriceOperation
  | AddCurrencyOptionOperation
  | UpdateTaxBehaviorOperation
  | ArchivePriceOperation;

/**
 * What Task 4's guards judge a plan by.
 *
 * Flat per-kind counts (not nested under a `byKind`) so a guard can read
 * `counts.replace_price` directly. `total`, `intended` and `driftCorrection`
 * exist because the breadth guard's whole point (spec §2) is comparing those
 * two against each other, not just against a raw operation count.
 */
export interface PublishPlanCounts {
  readonly create_product: number;
  readonly create_price: number;
  readonly replace_price: number;
  readonly add_currency_option: number;
  readonly update_tax_behavior: number;
  readonly archive_price: number;
  readonly total: number;
  readonly intended: number;
  readonly driftCorrection: number;
}

export interface PublishPlan {
  /** `create_product` operations first, then everything else in `lookup_key` order. */
  readonly operations: readonly PublishOperation[];
  /**
   * A SHA-256 over the sorted `(lookup_key, currency, unit_amount,
   * tax_behavior)` tuples of the OBSERVED input this plan was built against —
   * nothing else. It does NOT cover the draft, the ancestor, or Stripe facts
   * this module never reads (`product`, `recurring`, `active`, Price ids).
   * The executor retakes the observation at execute time and aborts if this
   * moves — see spec §2.1 — so it only has to catch the thing that would make
   * a stale plan unsafe: the Price data the plan's amounts were computed
   * against having changed since planning.
   */
  readonly fingerprint: string;
  readonly counts: PublishPlanCounts;
}

export interface PublishPlanInput {
  /** The published revision the draft was based on. Empty for a from-scratch bootstrap. */
  readonly ancestor?: readonly CatalogAmount[];
  /** What the operator wants now. */
  readonly draft?: readonly CatalogAmount[];
  /** What Stripe actually holds right now (`listPrices`, expanded). */
  readonly observed?: readonly StripePriceLike[];
}

// ---------------------------------------------------------------------------
// Coverage maps — the same (lookupKey -> currency -> cell) shape parity.ts
// folds catalog rows into, rebuilt here because that helper is module-private
// there. Kept minimal on purpose: this module only needs equality checks and
// value lookups, not the full `Coverage` machinery parity.ts uses for
// reporting.
// ---------------------------------------------------------------------------

interface Cell {
  readonly unitAmountMinor: number;
  readonly taxBehavior: TaxBehavior;
}

type CoverageMap = Map<string, Map<string, Cell>>;

function coverageMapOf(amounts: readonly CatalogAmount[]): CoverageMap {
  const byKey: CoverageMap = new Map();
  for (const row of amounts) {
    let currencies = byKey.get(row.lookupKey);
    if (!currencies) {
      currencies = new Map();
      byKey.set(row.lookupKey, currencies);
    }
    currencies.set(row.currency, {
      unitAmountMinor: row.unitAmountMinor,
      taxBehavior: row.taxBehavior,
    });
  }
  return byKey;
}

function cellEqual(a: Cell | undefined, b: Cell | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.unitAmountMinor === b.unitAmountMinor && a.taxBehavior === b.taxBehavior;
}

/**
 * Whole-row equality for a `lookup_key`: same currencies, same values, in
 * either map. Used for the price-level diffs (`create_price`, `archive_price`)
 * where "did the operator change this?" is a question about the whole row,
 * not one cell.
 */
function rowEqual(a: Map<string, Cell> | undefined, b: Map<string, Cell> | undefined): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  if (a.size !== b.size) return false;
  for (const [currency, cell] of a) {
    if (!cellEqual(cell, b.get(currency))) return false;
  }
  return true;
}

/**
 * The origin rule, stated once: a cell (or row) is `"intended"` when the
 * draft disagrees with the ancestor there, and `"drift-correction"` when the
 * draft agrees with the ancestor but Stripe doesn't. See the module header.
 */
function originFromEquality(ancestorEqualsDraft: boolean): OperationOrigin {
  return ancestorEqualsDraft ? "drift-correction" : "intended";
}

function cellOrigin(
  ancestorMap: CoverageMap,
  draftMap: CoverageMap,
  lookupKey: string,
  currency: string,
): OperationOrigin {
  const ancestorCell = ancestorMap.get(lookupKey)?.get(currency);
  const draftCell = draftMap.get(lookupKey)?.get(currency);
  return originFromEquality(cellEqual(ancestorCell, draftCell));
}

function rowOrigin(ancestorMap: CoverageMap, draftMap: CoverageMap, lookupKey: string): OperationOrigin {
  return originFromEquality(rowEqual(ancestorMap.get(lookupKey), draftMap.get(lookupKey)));
}

/** `"intended"` wins over `"drift-correction"` when several diffs fold into one operation. */
function combineOrigins(origins: readonly OperationOrigin[]): OperationOrigin {
  return origins.includes("intended") ? "intended" : "drift-correction";
}

// ---------------------------------------------------------------------------
// Building a Stripe-ready price from the draft
// ---------------------------------------------------------------------------

interface StripeReadyPrice {
  readonly currency: string;
  readonly unitAmount: number;
  readonly taxBehavior: TaxBehavior;
  readonly currencyOptions: Readonly<Record<string, CurrencyOptionValue>>;
}

/**
 * Which currency is the Price's own (the "baseline"), vs. which go in
 * `currency_options`.
 *
 * For an existing Price, Stripe already answered this — its `currency` field
 * IS the baseline, and `replace_price` must keep using it: the new Price is a
 * straight replacement, not a re-decision of which currency is primary.
 *
 * For a brand-new Price (`create_price`, no existing observation) there is
 * nothing to defer to. The catalog's own convention (spec §1.5) is that a
 * `developed` row's baseline is always `usd`; a `ppp` row has exactly one
 * currency, which is trivially its own baseline. Both are covered by: prefer
 * `usd` when present, otherwise the row's only currency. A multi-currency row
 * with no `usd` is not a shape the real catalog produces — the alphabetically
 * first currency is picked so the function stays total, but this branch is
 * untested against real data and should be treated as a smell if it ever
 * fires.
 */
function resolveBaselineCurrency(draftRow: Map<string, Cell>, existing: StripePriceLike | undefined): string {
  if (existing) return existing.currency;
  if (draftRow.has("usd")) return "usd";
  const [first] = [...draftRow.keys()].sort();
  return first ?? "usd";
}

function buildStripeReadyPrice(
  draftRow: Map<string, Cell>,
  policy: SourcePolicy,
  existing: StripePriceLike | undefined,
): StripeReadyPrice {
  const baseline = resolveBaselineCurrency(draftRow, existing);
  const baselineCell = draftRow.get(baseline);
  const currencyOptions: Record<string, CurrencyOptionValue> = {};
  for (const [currency, cell] of draftRow) {
    if (currency === baseline) continue;
    currencyOptions[currency] = {
      unitAmount: toStripeUnitAmount(currency, cell.unitAmountMinor, policy),
      taxBehavior: cell.taxBehavior,
    };
  }
  return {
    currency: baseline,
    // The schema guarantees a NOT NULL, `> 0` amount for every real row (see
    // `parity.ts`'s identical comment on `catalogMinor`); the `?? 0` only
    // guards a lookup key with no draft rows at all, which callers below
    // never produce.
    unitAmount: toStripeUnitAmount(baseline, baselineCell?.unitAmountMinor ?? 0, policy),
    taxBehavior: baselineCell?.taxBehavior ?? "unspecified",
    currencyOptions,
  };
}

// ---------------------------------------------------------------------------
// Classifying a matched price's diffs
// ---------------------------------------------------------------------------

/**
 * Does this `tax_behavior_mismatch` have an in-place path, or does it force a
 * `replace_price`?
 *
 * Only the BASELINE currency's own `tax_behavior` can move at all in place,
 * and only when it is currently `"unspecified"` (§1.4 — the transition is
 * one-way and single-use). Everything else — a non-baseline `currency_options`
 * entry, or a baseline already set to the other value — has no in-place path:
 * §1.6a found that setting `tax_behavior` on a `currency_options` entry also
 * requires resending `unit_amount`, and an existing currency's amount is
 * immutable, so that call would be refused exactly like an amount change
 * would be.
 */
function taxBehaviorRequiresReplace(currency: string, price: StripePriceLike): boolean {
  const isBaseline = currency === price.currency;
  if (!isBaseline) return true;
  return price.tax_behavior !== "unspecified" && price.tax_behavior !== null;
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Every currency one observed Price covers, as `(currency, unitAmount,
 * taxBehavior)` — the Price's own currency plus each `currency_options` key.
 * Deliberately NOT filtered by lookup-key prefix: the fingerprint's only job
 * is "did the observation this plan was computed against move", and it
 * covers exactly what the caller passed as `observed`, independent of which
 * of those rows ended up producing an operation.
 */
function observedTuples(observed: readonly StripePriceLike[]): string[] {
  const tuples: string[] = [];
  for (const p of observed) {
    const key = p.lookup_key ?? "";
    tuples.push(`${key} ${p.currency} ${p.unit_amount} ${p.tax_behavior ?? "unspecified"}`);
    for (const [currency, option] of Object.entries(p.currency_options ?? {})) {
      tuples.push(`${key} ${currency} ${option.unit_amount} ${option.tax_behavior ?? "unspecified"}`);
    }
  }
  return tuples;
}

function fingerprintObserved(observed: readonly StripePriceLike[]): string {
  const sorted = observedTuples(observed).sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// buildPublishPlan
// ---------------------------------------------------------------------------

export function buildPublishPlan(input: PublishPlanInput): PublishPlan {
  const ancestor = input.ancestor ?? [];
  const draft = input.draft ?? [];
  const observed = input.observed ?? [];

  const policy = policyFor(SINGLE_SOURCE);
  const namespacePrefix = policyFor(SINGLE_SOURCE).lookupKeyPrefix;

  // `compareCatalogToStripe` already solves the 42-vs-78 shape asymmetry and
  // the zero-decimal reconciliation (spec §2: "a second diff implementation
  // would have to solve both again and would disagree unadjudicatably"). What
  // it hands back is exactly "what must change to make Stripe match the
  // draft" — the WORK. Origin (who asked for it) is a separate question,
  // answered below against the ancestor.
  const diffs = compareCatalogToStripe(draft, observed, namespacePrefix, policy).differences;

  const ancestorMap = coverageMapOf(ancestor);
  const draftMap = coverageMapOf(draft);

  const observedByKey = new Map<string, StripePriceLike>();
  for (const price of observed) {
    const key = price.lookup_key;
    if (!key || !key.startsWith(namespacePrefix)) continue;
    if (!observedByKey.has(key)) observedByKey.set(key, price);
  }

  const byLookupKey = new Map<string, Difference[]>();
  for (const diff of diffs) {
    let group = byLookupKey.get(diff.lookupKey);
    if (!group) {
      group = [];
      byLookupKey.set(diff.lookupKey, group);
    }
    group.push(diff);
  }

  const productOperations: CreateProductOperation[] = [];
  const productPlansSeen = new Set<string>();
  const restOperations: PublishOperation[] = [];

  // `byLookupKey` iterates in insertion order, which followed `diffs`, which
  // `compareCatalogToStripe` already sorted by lookup key — so this loop
  // produces a deterministic, lookup-key-ordered plan without a second sort.
  for (const [lookupKey, keyDiffs] of byLookupKey) {
    const missingInStripe = keyDiffs.find((d) => d.kind === "price_missing_in_stripe");
    const missingInCatalog = keyDiffs.find(
      (d): d is PriceDifference => d.kind === "price_missing_in_catalog",
    );

    if (missingInCatalog) {
      // Draft no longer wants this lookup_key at all; the whole Price is
      // archived. `priceId` comes from the observation itself (`parity.ts`
      // only sets it on this diff kind, for exactly this reason).
      restOperations.push({
        kind: "archive_price",
        origin: rowOrigin(ancestorMap, draftMap, lookupKey),
        lookupKey,
        priceId: missingInCatalog.priceId ?? "",
      });
      continue;
    }

    if (missingInStripe) {
      const plan = planOf(lookupKey, namespacePrefix);
      if (!productPlansSeen.has(plan)) {
        productPlansSeen.add(plan);
        // Idempotent at execution time via the same `metadata.plan`
        // find-or-create lookup `billing-bootstrap` already uses (spec §4) —
        // so emitting one per NEW plan here, rather than trying to know
        // whether Stripe already has the Product, costs nothing and needs no
        // extra input to this pure function.
        productOperations.push({
          kind: "create_product",
          origin: rowOrigin(ancestorMap, draftMap, lookupKey),
          plan,
        });
      }
      const built = buildStripeReadyPrice(draftMap.get(lookupKey) ?? new Map(), policy, undefined);
      restOperations.push({
        kind: "create_price",
        origin: rowOrigin(ancestorMap, draftMap, lookupKey),
        lookupKey,
        plan,
        interval: expectedInterval(lookupKey),
        ...built,
      });
      continue;
    }

    const existing = observedByKey.get(lookupKey);
    const amountDiffs = keyDiffs.filter((d) => d.kind === "amount_mismatch");
    const taxDiffs = keyDiffs.filter((d) => d.kind === "tax_behavior_mismatch");
    const newCurrencyDiffs = keyDiffs.filter((d) => d.kind === "currency_missing_in_stripe");

    const taxDiffsRequiringReplace = existing
      ? taxDiffs.filter((d) => "currency" in d && taxBehaviorRequiresReplace(d.currency, existing))
      : taxDiffs;

    const needsReplace = amountDiffs.length > 0 || taxDiffsRequiringReplace.length > 0;

    if (needsReplace && existing) {
      // ONE new Price replaces the old one entirely (create + archive), so
      // this is a single operation per lookup key even when several cells
      // changed — a `replace_price` built from the FULL draft row already
      // fixes any `add_currency_option` or in-place tax_behavior need for
      // this key too, since the new Price is created with the complete
      // currency_options map from the start.
      const built = buildStripeReadyPrice(draftMap.get(lookupKey) ?? new Map(), policy, existing);
      const origin = combineOrigins([
        ...amountDiffs.map((d) => cellOrigin(ancestorMap, draftMap, lookupKey, (d as { currency: string }).currency)),
        ...taxDiffsRequiringReplace.map((d) =>
          cellOrigin(ancestorMap, draftMap, lookupKey, (d as { currency: string }).currency),
        ),
      ]);
      restOperations.push({
        kind: "replace_price",
        origin,
        lookupKey,
        oldPriceId: existing.id,
        ...built,
      });
      continue;
    }

    if (!existing) continue; // Nothing left to do without a live Price to act on.

    if (newCurrencyDiffs.length > 0) {
      const currencyOptions: Record<string, CurrencyOptionValue> = {};
      for (const diff of newCurrencyDiffs) {
        const currency = (diff as { currency: string }).currency;
        const cell = draftMap.get(lookupKey)?.get(currency);
        if (!cell) continue;
        currencyOptions[currency] = {
          unitAmount: toStripeUnitAmount(currency, cell.unitAmountMinor, policy),
          taxBehavior: cell.taxBehavior,
        };
      }
      restOperations.push({
        kind: "add_currency_option",
        origin: combineOrigins(
          newCurrencyDiffs.map((d) => cellOrigin(ancestorMap, draftMap, lookupKey, (d as { currency: string }).currency)),
        ),
        lookupKey,
        priceId: existing.id,
        currencyOptions,
      });
    }

    // Whatever's left in `taxDiffs` (i.e. not in `taxDiffsRequiringReplace`)
    // is, by construction, the baseline currency moving off `unspecified` —
    // the one in-place tax_behavior path. There is at most one: it is a
    // single field on the Price itself, not a per-currency map entry.
    const inPlaceTaxDiff = taxDiffs.find((d) => !taxDiffsRequiringReplace.includes(d));
    if (inPlaceTaxDiff && "catalogTaxBehavior" in inPlaceTaxDiff) {
      restOperations.push({
        kind: "update_tax_behavior",
        origin: cellOrigin(ancestorMap, draftMap, lookupKey, inPlaceTaxDiff.currency),
        lookupKey,
        priceId: existing.id,
        taxBehavior: inPlaceTaxDiff.catalogTaxBehavior,
      });
    }
  }

  const operations: PublishOperation[] = [...productOperations, ...restOperations];

  return {
    operations,
    fingerprint: fingerprintObserved(observed),
    counts: countOperations(operations),
  };
}

/**
 * Folds the finished operation list into the counts Task 4's guards read.
 * Built by reduction, not by mutating a pre-seeded object in a loop, so the
 * per-kind zeroes and the running totals are computed the same way instead of
 * one being an initial value and the other an accumulator.
 */
function countOperations(operations: readonly PublishOperation[]): PublishPlanCounts {
  const byKind: Record<OperationKind, number> = {
    create_product: 0,
    create_price: 0,
    replace_price: 0,
    add_currency_option: 0,
    update_tax_behavior: 0,
    archive_price: 0,
  };
  for (const op of operations) {
    byKind[op.kind] = byKind[op.kind] + 1;
  }
  const intended = operations.filter((op) => op.origin === "intended").length;
  return {
    ...byKind,
    total: operations.length,
    intended,
    driftCorrection: operations.length - intended,
  };
}
