import { describe, expect, it } from "vitest";
import { money, formatMoney } from "./money";

describe("money", () => {
  it("formats INR minor units as rupees", () => {
    expect(formatMoney(money(98420, "INR"))).toBe("₹984.20");
  });

  it("formats USD minor units as dollars", () => {
    expect(formatMoney(money(1500, "USD"))).toBe("$15.00");
  });

  it("rejects non-integer minor units", () => {
    // Guards the live footgun: HomeChef's payout amounts are float64 on the
    // wire, and three console pages disagreed about paise vs rupees.
    expect(() => money(12.5, "INR")).toThrow();
  });
});
