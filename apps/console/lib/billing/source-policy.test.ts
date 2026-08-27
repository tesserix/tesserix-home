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
