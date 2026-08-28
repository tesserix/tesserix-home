import { describe, expect, it } from "vitest";

import { MARK8LY_LOOKUP_KEY_PREFIX, type CatalogAmount } from "./parity";
import { checkGuards } from "./publish-guards";
import type {
  CreatePriceOperation,
  PublishPlan,
  PublishPlanCounts,
  PublishOperation,
  ReplacePriceOperation,
  UnactionableDifference,
} from "./publish-plan";

/**
 * `checkGuards`'s test surface — a `PublishPlan` and an ancestor row set in,
 * a verdict out. No `buildPublishPlan` call anywhere here: the guards are a
 * unit boundary of their own (spec §7), and building plans by hand keeps each
 * test isolated to the ONE rule it names instead of depending on the
 * classifier's behaviour too.
 */

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const KEY = `${MARK8LY_LOOKUP_KEY_PREFIX}k`;

function counts(operations: readonly PublishOperation[], unactionable = 0): PublishPlanCounts {
  const byKind = {
    create_product: 0,
    create_price: 0,
    replace_price: 0,
    add_currency_option: 0,
    update_tax_behavior: 0,
    archive_price: 0,
  };
  for (const op of operations) byKind[op.kind] += 1;
  const intended = operations.filter((op) => op.origin === "intended").length;
  return {
    ...byKind,
    total: operations.length,
    intended,
    driftCorrection: operations.length - intended,
    unactionable,
  };
}

function plan(
  operations: readonly PublishOperation[],
  unactionable: readonly UnactionableDifference[] = [],
): PublishPlan {
  return {
    operations,
    fingerprint: "fixture",
    counts: counts(operations, unactionable.length),
    unactionable,
  };
}

function replaceOp(overrides: Partial<ReplacePriceOperation> = {}): ReplacePriceOperation {
  return {
    kind: "replace_price",
    origin: "intended",
    lookupKey: KEY,
    oldPriceId: "price_old",
    currency: "usd",
    unitAmount: 1000,
    taxBehavior: "unspecified",
    currencyOptions: {},
    ...overrides,
  };
}

function createOp(overrides: Partial<CreatePriceOperation> = {}): CreatePriceOperation {
  return {
    kind: "create_price",
    origin: "intended",
    lookupKey: KEY,
    plan: "starter",
    interval: "month",
    currency: "usd",
    unitAmount: 1000,
    taxBehavior: "unspecified",
    currencyOptions: {},
    ...overrides,
  };
}

function ancestorAt(unitAmountMinor: number): CatalogAmount[] {
  return [{ lookupKey: KEY, currency: "usd", unitAmountMinor, taxBehavior: "unspecified" }];
}

/**
 * One `replace_price` moving `usd` to `newAmount`. `_oldAmount` is unused —
 * the old value lives in the ancestor fixture the test passes separately —
 * but kept as a parameter so a call site reads as "1000 -> 100", not
 * "changes to 100 from something".
 */
function planWithAmountChange(_oldAmount: number, newAmount: number): PublishPlan {
  return plan([replaceOp({ unitAmount: newAmount })]);
}

function planWith(counts_: { intended: number; drift: number }): PublishPlan {
  const operations: PublishOperation[] = [];
  for (let i = 0; i < counts_.intended; i++) {
    operations.push(createOp({ lookupKey: `${KEY}_i${i}`, origin: "intended" }));
  }
  for (let i = 0; i < counts_.drift; i++) {
    operations.push(createOp({ lookupKey: `${KEY}_d${i}`, origin: "drift-correction" }));
  }
  return plan(operations);
}

function planDropping(currency: string): PublishPlan {
  return plan([], [{ kind: "currency_missing_in_catalog", lookupKey: KEY, currency }]);
}

const TRIVIAL_PLAN = plan([]);
const ANY: CatalogAmount[] = [];

/** 42 creates into an empty mode — spec §7's named bootstrap case. */
const BOOTSTRAP_PLAN = plan(
  Array.from({ length: 42 }, (_, i) => createOp({ lookupKey: `${KEY}_${i}`, origin: "intended" })),
);
const EMPTY_ANCESTOR: CatalogAmount[] = [];

// ---------------------------------------------------------------------------

describe("checkGuards", () => {
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

  it("counts breadth in INTENDED entries, not drift corrections, below the total threshold", () => {
    // "40 entries" is meaningless on its own. "1 intended, 5 drift" and "11
    // intended" are entirely different events — but see the next test for
    // what happens once TOTAL entries, regardless of split, gets large: the
    // intended-only count is fail-safe in one direction (see the header) and
    // blind in the other, which is F2 below.
    expect(checkGuards(planWith({ intended: 1, drift: 5 }), ANY, "test")).toEqual({ ok: true });
    expect(checkGuards(planWith({ intended: 11, drift: 0 }), ANY, "test")).toMatchObject({ ok: false });
  });

  it("requires confirmation for an all-drift plan once TOTAL entries cross the breadth threshold", () => {
    // F2 (whole-branch fix wave, 2026-08-28): `checkBreadth` used to read
    // ONLY `counts.intended`. `ancestor === draft` with an empty or wrong
    // observation (a truncated `listPrices` page, the wrong account, a mode
    // mix-up upstream) makes EVERY row a `price_missing_in_stripe` diff and
    // EVERY operation `drift-correction` — so `counts.intended` stays 0 no
    // matter how large the plan gets, and no guard ever fired. This is the
    // largest blast radius the system can produce (spec §7's "a correct
    // mechanism publishing a wrong number"), and it must at least require a
    // confirmation, even though no single cell is "intended".
    const v = checkGuards(planWith({ intended: 0, drift: 40 }), ANY, "test");
    expect(v).toMatchObject({ ok: false, requiresConfirmation: expect.anything() });
  });

  it("refuses a developed price that does not carry all seven currencies", () => {
    // Not a Stripe error — it is checkout failing in the UK. No operation in
    // the plan catches it, because "fewer currencies" is a legitimate
    // in-place update.
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
    expect(checkGuards(BOOTSTRAP_PLAN, EMPTY_ANCESTOR, "test")).toMatchObject({
      ok: false,
      requiresConfirmation: expect.anything(),
    });
  });

  it("passes a plan with no operations and no drift", () => {
    expect(checkGuards(TRIVIAL_PLAN, ANY, "test")).toEqual({ ok: true });
  });

  it("does not confirm magnitude for a brand-new price with no ancestor cell", () => {
    // A `create_price` into an empty ancestor has nothing to measure a
    // percentage change against — there is no prior amount, only a first
    // one. Distinct from the breadth guard, which DOES fire on the same
    // fixture in the bootstrap test above.
    const v = checkGuards(plan([createOp({ unitAmount: 999_999 })]), EMPTY_ANCESTOR, "test");
    expect(v).toEqual({ ok: true });
  });
});
