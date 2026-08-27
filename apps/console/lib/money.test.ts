import { describe, expect, it } from "vitest";

import { formatMoney, minorUnitExponent } from "./money";

/**
 * Pins the exponent DECISION, not the rendered string.
 *
 * `minorUnitExponent` is what replaced `Intl.NumberFormat(...).resolvedOptions()
 * .maximumFractionDigits` as `formatMoney`'s source of truth for how many
 * decimals a minor-unit amount divides by. That CLDR-derived number disagreed
 * with ISO 4217 for IDR, and disagreed with ITSELF across runtimes — Chrome's
 * en-US locale resolves IDR to 0 fraction digits, Node's ICU resolves it to 2
 * — so a snapshot of `formatMoney`'s OUTPUT string would have passed in this
 * test suite while shipping a hundredfold overstatement to every operator's
 * actual browser (exactly what happened to the plan-catalog surface first,
 * fixed locally there, and now fixed here at the shared source). Asserting
 * the exponent directly against a table, independent of any `Intl` call,
 * is the only way this suite can catch that class of regression again.
 */
describe("minorUnitExponent — a runtime-independent fact, never Intl's opinion", () => {
  it.each([
    ["idr", 2], // NOT zero-decimal in Stripe/ISO — this shipped wrong in Chrome
    ["vnd", 0], // zero-decimal
    ["usd", 2],
    ["jpy", 0], // zero-decimal
    // Uppercase, matching the shape the federated billing surface actually
    // hands `formatMoney` (`billing-views.tsx`'s fixtures use "AUD").
    ["IDR", 2],
    ["VND", 0],
  ] as const)("resolves %s to an exponent of %i", (currency, exponent) => {
    expect(minorUnitExponent(currency)).toBe(exponent);
  });
});

describe("formatMoney — IDR and VND, end to end", () => {
  it("divides IDR by 100 (2-decimal), never by 1", () => {
    // A real Stripe unit_amount, as `formatMoney`'s existing callers already
    // hand it minor units in — this is not a catalog-storage value.
    const rendered = formatMoney({ amount: 1_198_800_000, currency: "IDR" });
    expect(rendered).toMatch(/11,988,000/);
    expect(rendered).not.toMatch(/1,198,800,000/);
  });

  it("divides VND by 1 (0-decimal), never by 100", () => {
    const rendered = formatMoney({ amount: 1_978_800, currency: "VND" });
    expect(rendered).toMatch(/1,978,800/);
    expect(rendered).not.toMatch(/19,788\.00/);
  });

  it("still renders a familiar 2-decimal currency correctly", () => {
    expect(formatMoney({ amount: 4900, currency: "AUD" })).toMatch(/49\.00/);
  });

  it("still returns the em dash for an absent value", () => {
    expect(formatMoney(undefined)).toBe("—");
  });

  it("still falls back to the raw pair for an unrecognised currency code", () => {
    expect(formatMoney({ amount: 500, currency: "ZZZ" })).toBe("500 ZZZ");
  });
});
