import { describe, expect, it } from "vitest";

import { hasReasonCodes, reasonCodesFor } from "./tenant-lifecycle";

describe("reasonCodesFor", () => {
  it("offers mark8ly's declared suspend codes", () => {
    const codes = reasonCodesFor("mark8ly", "suspend").map((r) => r.code);
    expect(codes).toEqual([
      "abuse",
      "fraud",
      "non_payment",
      "legal",
      "tos_violation",
      "security",
      "voluntary",
    ]);
  });

  // Deliberately a different set. The reason a suspension ends is not the
  // reason it began, and mark8ly's own comment says so.
  it("offers a different set for unsuspend", () => {
    const codes = reasonCodesFor("mark8ly", "unsuspend").map((r) => r.code);
    expect(codes).toEqual(["resolved", "appeal_upheld", "operator_error", "voluntary_end"]);
    expect(codes).not.toContain("fraud");
  });

  // Borrowing one product's vocabulary for another's tenant is how a wrong
  // reason lands on an audit row. An empty menu is a visible gap; a borrowed
  // one is an invisible error.
  it("returns nothing for a product this build does not know", () => {
    expect(reasonCodesFor("kora", "suspend")).toEqual([]);
    expect(hasReasonCodes("kora")).toBe(false);
  });

  it("knows mark8ly", () => {
    expect(hasReasonCodes("mark8ly")).toBe(true);
  });

  it("gives every code a label distinct from the code itself", () => {
    for (const verb of ["suspend", "unsuspend"] as const) {
      for (const entry of reasonCodesFor("mark8ly", verb)) {
        expect(entry.label).not.toBe(entry.code);
        expect(entry.label.length).toBeGreaterThan(entry.code.length);
      }
    }
  });
});
