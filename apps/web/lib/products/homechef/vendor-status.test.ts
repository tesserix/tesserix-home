import { describe, expect, it } from "vitest";

import {
  vendorStatusLabel,
  vendorStatusHint,
  canSeedSandboxBank,
  vendorSyncAction,
} from "./vendor-status";

// Home-Chef-App #1122: the roster showed Cashfree's raw verdict —
// BANK_VALIDATION_FAILED, or a blank cell — and an operator could press
// Re-check forever without learning that the chef has to fix the details
// themselves, in the vendor app. Neither is something admin can enter here.
describe("vendorStatusLabel", () => {
  it("names the failure in words an operator can act on", () => {
    expect(vendorStatusLabel("BANK_VALIDATION_FAILED")).toBe(
      "Bank details rejected",
    );
  });

  it("distinguishes a verdict still pending from one that failed", () => {
    expect(vendorStatusLabel("IN_BANK_VALIDATION")).toBe(
      "Bank details verifying",
    );
  });

  it("reads as not registered when Cashfree has never seen the chef", () => {
    expect(vendorStatusLabel("")).toBe("Not registered");
    expect(vendorStatusLabel(undefined)).toBe("Not registered");
  });

  it("passes an unmapped status through rather than inventing one", () => {
    expect(vendorStatusLabel("SOME_NEW_STATE")).toBe("SOME_NEW_STATE");
  });

  it("is case-insensitive — the status is echoed from the gateway", () => {
    expect(vendorStatusLabel("bank_validation_failed")).toBe(
      "Bank details rejected",
    );
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

// The seeder puts Cashfree's own documented sandbox account on file so nobody
// types a bank account number by hand. The API refuses it unless the chef's
// mode resolves to the sandbox payout rail, so offering it on a live kitchen
// would only ever produce a 409 — and inviting the press is the risk itself.
describe("canSeedSandboxBank", () => {
  it("offers the seed only to a test-mode kitchen", () => {
    expect(canSeedSandboxBank("test")).toBe(true);
  });

  it("withholds it from a live kitchen, whose rail is real money", () => {
    expect(canSeedSandboxBank("live")).toBe(false);
  });

  it("treats an unset mode as live — the safer reading", () => {
    expect(canSeedSandboxBank("")).toBe(false);
    expect(canSeedSandboxBank(undefined)).toBe(false);
  });

  it("is case-insensitive, matching the server's mode normaliser", () => {
    expect(canSeedSandboxBank("TEST")).toBe(true);
  });
});

// #88. A rejected vendor was offered Re-check, which re-reads a verdict that
// never changes. Only a re-submission carries the corrected details to Cashfree.
describe("vendorSyncAction", () => {
  it("re-submits a rejected vendor instead of re-reading the refusal", () => {
    expect(vendorSyncAction("BANK_VALIDATION_FAILED", "hc_abc")).toEqual({
      endpoint: "register",
      label: "Re-submit",
    });
  });

  it("registers a kitchen Cashfree has never seen", () => {
    expect(vendorSyncAction("", "")).toEqual({
      endpoint: "register",
      label: "Register",
    });
  });

  it("re-checks a submission still in flight rather than sending it again", () => {
    expect(vendorSyncAction("IN_BANK_VALIDATION", "hc_abc")).toEqual({
      endpoint: "refresh",
      label: "Re-check",
    });
    expect(vendorSyncAction("IN_BENE_CREATION", "hc_abc")).toEqual({
      endpoint: "refresh",
      label: "Re-check",
    });
  });

  it("offers nothing on an active vendor — there is nothing left to do", () => {
    expect(vendorSyncAction("ACTIVE", "hc_abc")).toBeNull();
  });

  it("is case-insensitive, like every other reading of this status", () => {
    expect(vendorSyncAction("bank_validation_failed", "hc_abc")?.endpoint).toBe(
      "register",
    );
  });
});
