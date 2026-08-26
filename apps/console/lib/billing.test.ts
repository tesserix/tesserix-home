import { describe, expect, it } from "vitest";

import { parseSubscriptions, parseTrials } from "./billing";
import { formatMoney } from "./money";

const subsBody = {
  data: [
    {
      source: "mark8ly",
      tenant_id: "t1",
      tenant_name: "Acme",
      plan: "pro",
      status: "active",
      amount: { amount: 4900, currency: "AUD" },
      current_period_end: "2026-09-30T00:00:00Z",
      cancel_at_period_end: false,
    },
  ],
  total: 37,
  failures: [],
};

const trialsBody = {
  data: [
    {
      source: "mark8ly",
      tenant_id: "t3",
      trial_ends_at: "2026-09-10T00:00:00Z",
      days_remaining: 9,
      plan: "pro",
      payment_method_on_file: false,
      status: "trialing",
      stripe_managed: false,
    },
  ],
  total: 5,
  failures: [],
};

describe("parseSubscriptions", () => {
  it("reads the platform API's shape", () => {
    const page = parseSubscriptions(subsBody);
    expect(page.data[0]?.tenantName).toBe("Acme");
    expect(page.data[0]?.amount).toEqual({ amount: 4900, currency: "AUD" });
    expect(page.total).toBe(37);
  });

  // Absent is not zero. Rendering a missing price as 0 says "this tenant pays
  // nothing", a different and wrong claim.
  it("leaves an unresolvable amount absent rather than zero", () => {
    const { amount: _dropped, ...noAmount } = subsBody.data[0] as Record<string, unknown>;
    const page = parseSubscriptions({ ...subsBody, data: [noAmount] });
    expect(page.data[0]?.amount).toBeUndefined();
  });

  // §4.2 admits no exception, and §8.2 names this as THE likely failure —
  // Stripe amounts already arrive in minor units and the temptation is to pass
  // them through uncurrencied.
  it("refuses money with no currency rather than rendering a bare number", () => {
    expect(() =>
      parseSubscriptions({ ...subsBody, data: [{ ...subsBody.data[0], amount: { amount: 4900 } }] }),
    ).toThrow(/currency/);
    expect(() =>
      parseSubscriptions({
        ...subsBody,
        data: [{ ...subsBody.data[0], amount: { amount: 4900, currency: "" } }],
      }),
    ).toThrow(/currency/);
  });

  it("refuses a body with no failures or no total", () => {
    expect(() => parseSubscriptions({ data: [], total: 0 })).toThrow(/failures/);
    expect(() => parseSubscriptions({ data: [], failures: [] })).toThrow(/total/);
  });

  it("requires a source on every row", () => {
    const { source: _dropped, ...noSource } = subsBody.data[0] as Record<string, unknown>;
    expect(() => parseSubscriptions({ ...subsBody, data: [noSource] })).toThrow(/source/);
  });
});

describe("parseTrials", () => {
  it("reads the shape, including the field that makes it a queue", () => {
    const page = parseTrials(trialsBody);
    expect(page.data[0]?.daysRemaining).toBe(9);
    expect(page.data[0]?.paymentMethodOnFile).toBe(false);
    expect(page.total).toBe(5);
  });

  it("reads failures, which is what makes a partial estate renderable", () => {
    const page = parseTrials({
      ...trialsBody,
      failures: [{ source: "kora", message: "connection failed" }],
    });
    expect(page.failures[0]?.source).toBe("kora");
  });
});

describe("formatMoney", () => {
  // The estate already spans AUD, INR and USD. A hardcoded "$" would be wrong
  // for two of the three.
  it("renders each currency in its own denomination", () => {
    expect(formatMoney({ amount: 4900, currency: "AUD" })).toMatch(/49/);
    expect(formatMoney({ amount: 510000, currency: "INR" })).toMatch(/5,100/);
  });

  // JPY has no minor unit at all, so a hardcoded /100 would be wrong by a
  // factor of a hundred. Intl knows the exponent; a constant does not.
  it("respects a currency with no minor unit", () => {
    expect(formatMoney({ amount: 4900, currency: "JPY" })).toMatch(/4,900/);
  });

  it("renders an em dash when there is no amount", () => {
    expect(formatMoney(undefined)).toBe("—");
  });

  // An unrecognised code is the product's problem to fix, not this renderer's
  // to hide. Showing the raw pair is honest and diagnosable.
  it("falls back to the raw pair for an unknown currency", () => {
    expect(formatMoney({ amount: 100, currency: "ZZZ" })).toBe("100 ZZZ");
  });
});
