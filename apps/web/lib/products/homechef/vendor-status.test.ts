import { describe, expect, it } from "vitest";

import { vendorStatusLabel, vendorStatusHint } from "./vendor-status";

// Home-Chef-App #1122: the roster showed Cashfree's raw verdict —
// BANK_VALIDATION_FAILED, or a blank cell — and an operator could press
// Re-check forever without learning that the chef has to fix the details
// themselves, in the vendor app. Neither is something admin can enter here.
describe("vendorStatusLabel", () => {
  it("names the failure in words an operator can act on", () => {
    expect(vendorStatusLabel("BANK_VALIDATION_FAILED")).toBe("Bank details rejected");
  });

  it("distinguishes a verdict still pending from one that failed", () => {
    expect(vendorStatusLabel("IN_BANK_VALIDATION")).toBe("Bank details verifying");
  });

  it("reads as not registered when Cashfree has never seen the chef", () => {
    expect(vendorStatusLabel("")).toBe("Not registered");
    expect(vendorStatusLabel(undefined)).toBe("Not registered");
  });

  it("passes an unmapped status through rather than inventing one", () => {
    expect(vendorStatusLabel("SOME_NEW_STATE")).toBe("SOME_NEW_STATE");
  });

  it("is case-insensitive — the status is echoed from the gateway", () => {
    expect(vendorStatusLabel("bank_validation_failed")).toBe("Bank details rejected");
  });
});

describe("vendorStatusHint", () => {
  it("points a rejected chef at the vendor app, not at the Re-check button", () => {
    expect(vendorStatusHint("BANK_VALIDATION_FAILED")).toMatch(/vendor app/i);
  });

  it("tells the operator to wait while a verdict is pending", () => {
    expect(vendorStatusHint("IN_BANK_VALIDATION")).toMatch(/re-check/i);
  });

  it("says an unregistered chef has nothing to submit yet", () => {
    expect(vendorStatusHint("")).toMatch(/payout details/i);
  });

  it("has nothing to say about an active vendor", () => {
    expect(vendorStatusHint("ACTIVE")).toBeNull();
  });
});
