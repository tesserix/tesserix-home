import { describe, expect, it } from "vitest";

import { MARK8LY_LOOKUP_KEY_PREFIX, type CatalogAmount, type StripePriceLike, type TaxBehavior } from "./parity";
import {
  buildPublishPlan,
  type AddCurrencyOptionOperation,
  type PublishOperation,
} from "./publish-plan";

/**
 * `buildPublishPlan`'s whole test surface — three fixture arrays in, a typed
 * plan out. No Stripe client, no database: same discipline as
 * `parity.test.ts`, for the same reason (see that file's header) — this is
 * the function that decides what gets WRITTEN to a live Stripe account.
 *
 * Fixtures use `mark8ly_`-prefixed lookup keys throughout, because
 * `compareCatalogToStripe` (which this module delegates the diffing to)
 * filters the OBSERVED side by that prefix — an unprefixed key would look
 * like a Price Stripe doesn't have, regardless of what `observed` actually
 * contains.
 */

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function amount(
  lookupKey: string,
  currency: string,
  unitAmountMinor: number,
  taxBehavior: TaxBehavior = "unspecified",
): CatalogAmount {
  return { lookupKey, currency, unitAmountMinor, taxBehavior };
}

function price(overrides: {
  lookup_key: string;
  currency: string;
  unit_amount: number;
  id?: string;
  tax_behavior?: TaxBehavior;
  currency_options?: StripePriceLike["currency_options"];
  recurring?: StripePriceLike["recurring"];
}): StripePriceLike {
  return {
    id: overrides.id ?? `price_${overrides.lookup_key}`,
    lookup_key: overrides.lookup_key,
    currency: overrides.currency,
    unit_amount: overrides.unit_amount,
    tax_behavior: overrides.tax_behavior ?? "unspecified",
    active: true,
    currency_options: overrides.currency_options,
    recurring: overrides.recurring,
  };
}

/** 3 plans x 2 periods x (1 developed + 6 ppp) = 42 lookup keys, 78 amounts — spec §1.8. */
const PLANS = ["starter", "pro", "enterprise"];
const PERIODS = ["monthly", "annual"] as const;
const DEVELOPED_CURRENCIES = ["eur", "gbp", "aud", "cad", "chf", "jpy"];
const PPP_CURRENCIES = ["inr", "brl", "mxn", "idr", "vnd", "ngn"];

function fullCatalog(): CatalogAmount[] {
  const rows: CatalogAmount[] = [];
  for (const plan of PLANS) {
    for (const period of PERIODS) {
      const developedKey = `${MARK8LY_LOOKUP_KEY_PREFIX}${plan}_${period}_developed_v1`;
      rows.push(amount(developedKey, "usd", 1000));
      for (const currency of DEVELOPED_CURRENCIES) {
        rows.push(amount(developedKey, currency, 900));
      }
      for (const currency of PPP_CURRENCIES) {
        const pppKey = `${MARK8LY_LOOKUP_KEY_PREFIX}${plan}_${period}_ppp_${currency}_v1`;
        rows.push(amount(pppKey, currency, 500));
      }
    }
  }
  return rows;
}

function isAddCurrencyOption(op: PublishOperation): op is AddCurrencyOptionOperation {
  return op.kind === "add_currency_option";
}

// ---------------------------------------------------------------------------

describe("buildPublishPlan", () => {
  it("labels a change the operator made as intended", () => {
    const plan = buildPublishPlan({
      ancestor: [amount(`${MARK8LY_LOOKUP_KEY_PREFIX}k_usd`, "usd", 1000)],
      draft: [amount(`${MARK8LY_LOOKUP_KEY_PREFIX}k_usd`, "usd", 1200)],
      observed: [
        price({ lookup_key: `${MARK8LY_LOOKUP_KEY_PREFIX}k_usd`, currency: "usd", unit_amount: 1000 }),
      ],
    });
    expect(plan.operations.map((o) => o.origin)).toEqual(["intended"]);
  });

  it("labels a Stripe-side edit as drift-correction, and still publishes it", () => {
    // Without the label, publishing silently reverts a Dashboard change and
    // nobody is told. The operator sees both counts before confirming.
    const plan = buildPublishPlan({
      ancestor: [amount(`${MARK8LY_LOOKUP_KEY_PREFIX}k_usd`, "usd", 1000)],
      draft: [amount(`${MARK8LY_LOOKUP_KEY_PREFIX}k_usd`, "usd", 1000)],
      observed: [
        price({ lookup_key: `${MARK8LY_LOOKUP_KEY_PREFIX}k_usd`, currency: "usd", unit_amount: 999 }),
      ],
    });
    expect(plan.operations.map((o) => o.origin)).toEqual(["drift-correction"]);
  });

  it("classifies a non-baseline currency edit as a REPLACEMENT, not an in-place update", () => {
    // The single most important consequence of the 2026-08-27 experiments. An
    // earlier draft of this plan expected `update_currency_options` here, for
    // 36 of 78 cells. Stripe refuses that outright — an existing currency's
    // amount is immutable — so a plan builder emitting it would produce a
    // publish that fails on every one of those cells at execution time.
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_dev`;
    const plan = buildPublishPlan({
      ancestor: [amount(key, "usd", 1000), amount(key, "gbp", 800)],
      draft: [amount(key, "usd", 1000), amount(key, "gbp", 850)],
      observed: [
        price({
          lookup_key: key,
          currency: "usd",
          unit_amount: 1000,
          currency_options: { gbp: { unit_amount: 800, tax_behavior: "unspecified" } },
        }),
      ],
    });
    expect(plan.operations[0]?.kind).toBe("replace_price");
  });

  it("classifies a currency the price does not yet carry as an in-place add", () => {
    // The ONLY in-place amount write that exists.
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_dev2`;
    const plan = buildPublishPlan({
      ancestor: [amount(key, "usd", 1000)],
      draft: [amount(key, "usd", 1000), amount(key, "chf", 900)],
      observed: [price({ lookup_key: key, currency: "usd", unit_amount: 1000 })],
    });
    expect(plan.operations[0]?.kind).toBe("add_currency_option");
  });

  it("classifies a baseline-currency edit as a replacement", () => {
    // unit_amount is immutable, so the usd cell can only be changed by
    // minting a new Price and transferring the lookup key.
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_usd2`;
    const plan = buildPublishPlan({
      ancestor: [amount(key, "usd", 1000)],
      draft: [amount(key, "usd", 1200)],
      observed: [price({ lookup_key: key, currency: "usd", unit_amount: 1000 })],
    });
    expect(plan.operations[0]?.kind).toBe("replace_price");
  });

  it("classifies a tax_behavior change FROM a set value as a replacement", () => {
    // "Once specified as either inclusive or exclusive, it cannot be
    // changed." All six aud cells are already exclusive.
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_aud`;
    const plan = buildPublishPlan({
      ancestor: [amount(key, "aud", 1000, "exclusive")],
      draft: [amount(key, "aud", 1000, "inclusive")],
      observed: [
        price({ lookup_key: key, currency: "aud", unit_amount: 1000, tax_behavior: "exclusive" }),
      ],
    });
    expect(plan.operations[0]?.kind).toBe("replace_price");
  });

  it("sets tax_behavior in place when it moves off unspecified on the baseline currency", () => {
    // The one path §1.4 leaves open: unspecified -> a value, on the Price
    // itself, not a currency_options entry.
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_unspecified`;
    const plan = buildPublishPlan({
      ancestor: [amount(key, "usd", 1000, "unspecified")],
      draft: [amount(key, "usd", 1000, "exclusive")],
      observed: [
        price({ lookup_key: key, currency: "usd", unit_amount: 1000, tax_behavior: "unspecified" }),
      ],
    });
    expect(plan.operations[0]?.kind).toBe("update_tax_behavior");
  });

  it("emits create_product before any create_price that references it", () => {
    const plan = buildPublishPlan({ ancestor: [], draft: fullCatalog(), observed: [] });
    const kinds = plan.operations.map((o) => o.kind);
    expect(kinds.indexOf("create_product")).toBeLessThan(kinds.indexOf("create_price"));
    expect(plan.counts).toMatchObject({ create_product: 3, create_price: 42 });
  });

  it("sends only the currency being added, because the map merges", () => {
    // VERIFIED 2026-08-27: `currency_options` MERGES — a price carrying
    // gbp/eur/aud, updated with only gbp, kept all three. An earlier draft
    // required resending all six on the theory that the map is replaced.
    // That was inferred from the field being `Emptyable` and was wrong;
    // `metadata` in the same interface is also `Emptyable` and merges.
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_merge`;
    const plan = buildPublishPlan({
      ancestor: [amount(key, "usd", 1000), amount(key, "gbp", 800), amount(key, "eur", 750)],
      draft: [
        amount(key, "usd", 1000),
        amount(key, "gbp", 800),
        amount(key, "eur", 750),
        amount(key, "chf", 900),
      ],
      observed: [
        price({
          lookup_key: key,
          currency: "usd",
          unit_amount: 1000,
          currency_options: {
            gbp: { unit_amount: 800, tax_behavior: "unspecified" },
            eur: { unit_amount: 750, tax_behavior: "unspecified" },
          },
        }),
      ],
    });
    const op = plan.operations.find(isAddCurrencyOption);
    expect(op).toBeDefined();
    expect(Object.keys(op!.currencyOptions)).toEqual(["chf"]);
  });

  it("fingerprints the observation it planned against", () => {
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_fp`;
    const a = buildPublishPlan({
      observed: [price({ lookup_key: key, currency: "usd", unit_amount: 100 })],
    });
    const b = buildPublishPlan({
      observed: [price({ lookup_key: key, currency: "usd", unit_amount: 101 })],
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("does not change the fingerprint when the draft or ancestor change but the observation doesn't", () => {
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_fp2`;
    const observed = [price({ lookup_key: key, currency: "usd", unit_amount: 100 })];
    const a = buildPublishPlan({ draft: [amount(key, "usd", 100)], observed });
    const b = buildPublishPlan({ draft: [amount(key, "usd", 999)], observed });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("archives a price whose lookup key the draft no longer wants", () => {
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_retired`;
    const plan = buildPublishPlan({
      ancestor: [amount(key, "usd", 1000)],
      draft: [],
      observed: [price({ lookup_key: key, currency: "usd", unit_amount: 1000, id: "price_retired" })],
    });
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: "archive_price", lookupKey: key, priceId: "price_retired", origin: "intended" }),
    ]);
  });

  it("converts zero-decimal currency amounts through toStripeUnitAmount before they reach an operation", () => {
    // VND is zero-decimal in Stripe; the catalog stores it x100 (source
    // policy). A create_price op that skipped the conversion would send
    // Stripe 100x the intended amount.
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_vnd`;
    const plan = buildPublishPlan({ ancestor: [], draft: [amount(key, "vnd", 100000)], observed: [] });
    const created = plan.operations.find((o) => o.kind === "create_price");
    expect(created).toMatchObject({ currency: "vnd", unitAmount: 1000 });
  });

  it("labels a replace as intended when an intended new-currency addition rides along with a drift-triggered replace", () => {
    // Review finding, 2026-08-28: `combineOrigins` for `replace_price` only
    // looked at `amountDiffs` and `taxDiffsRequiringReplace` — never
    // `newCurrencyDiffs` — even though `buildStripeReadyPrice` folds every
    // draft currency, new ones included, into that same operation's
    // `currencyOptions`. Here usd drifted (nobody asked for it) while gbp is
    // a genuinely new, operator-added currency; both land in ONE
    // replace_price (drift forces the replace; the new currency rides along
    // inside it). The label must reflect the intended contribution, not just
    // the one that forced the replace.
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_mixed`;
    const plan = buildPublishPlan({
      ancestor: [amount(key, "usd", 1000)],
      draft: [amount(key, "usd", 1000), amount(key, "gbp", 800)],
      observed: [price({ lookup_key: key, currency: "usd", unit_amount: 999 })],
    });
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: "replace_price", origin: "intended" }),
    ]);
  });

  it("surfaces diffs no operation can fix as unactionable, and counts them", () => {
    // Neither kind has a Stripe API call that could act on it: there is no
    // way to remove a currency from currency_options, and fixing a shape
    // mismatch needs the comparator widening spec §2 describes as a
    // prerequisite for creation. Dropping them from the operation union is
    // right; dropping them from the plan's observability is not — the
    // nightly parity check will keep reporting these regardless, and a
    // publish that goes silent about them would look like it fixed
    // something it didn't.
    const extraCurrencyKey = `${MARK8LY_LOOKUP_KEY_PREFIX}k_extra_currency`;
    const wrongShapeKey = `${MARK8LY_LOOKUP_KEY_PREFIX}k_shape_annual_v1`;
    const plan = buildPublishPlan({
      ancestor: [amount(extraCurrencyKey, "usd", 1000), amount(wrongShapeKey, "usd", 1000)],
      draft: [amount(extraCurrencyKey, "usd", 1000), amount(wrongShapeKey, "usd", 1000)],
      observed: [
        price({
          lookup_key: extraCurrencyKey,
          currency: "usd",
          unit_amount: 1000,
          currency_options: { eur: { unit_amount: 700, tax_behavior: "unspecified" } },
        }),
        price({
          lookup_key: wrongShapeKey,
          currency: "usd",
          unit_amount: 1000,
          recurring: { interval: "month" },
        }),
      ],
    });
    expect(plan.operations).toEqual([]);
    expect(plan.counts.unactionable).toBe(2);
    expect(plan.unactionable).toEqual(
      expect.arrayContaining([
        { kind: "currency_missing_in_catalog", lookupKey: extraCurrencyKey, currency: "eur" },
        { kind: "price_shape_mismatch", lookupKey: wrongShapeKey, field: "interval" },
      ]),
    );
  });
});
