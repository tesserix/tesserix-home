import { describe, expect, it } from "vitest";

import { compareEntitlements, type EntitlementCell } from "./entitlement-parity";

// One product's compiled matrix, small enough to reason about. The shape is
// `EntitlementMatrix["plans"]` — plan -> feature -> value — carried verbatim
// from the federated response.
const matrix = { pro: { stores: -1, sso: 1 } };

const agreeing: EntitlementCell[] = [
  { plan: "pro", feature: "stores", value: -1 },
  { plan: "pro", feature: "sso", value: 1 },
];

describe("compareEntitlements", () => {
  it("reports no differences when both sides agree", () => {
    expect(compareEntitlements(agreeing, matrix)).toEqual([]);
  });

  it("reports a differing value with both sides named", () => {
    expect(
      compareEntitlements(
        [{ plan: "pro", feature: "stores", value: 3 }, { plan: "pro", feature: "sso", value: 1 }],
        matrix,
      ),
    ).toEqual([{ plan: "pro", feature: "stores", consoleValue: 3, productValue: -1 }]);
  });

  it("reports a feature the console lacks", () => {
    expect(compareEntitlements([{ plan: "pro", feature: "stores", value: -1 }], matrix)).toEqual([
      { plan: "pro", feature: "sso", consoleValue: null, productValue: 1 },
    ]);
  });

  it("reports a feature only the console has", () => {
    expect(
      compareEntitlements(
        [...agreeing, { plan: "pro", feature: "teleport", value: 1 }],
        matrix,
      ),
    ).toEqual([{ plan: "pro", feature: "teleport", consoleValue: 1, productValue: null }]);
  });

  // A MISSING entitlement must never read as agreement with a disabled one.
  // 0 means Disabled AND is the zero value; if absence collapsed to 0 here, a
  // console that failed to load its rows would report parity-clean against a
  // matrix that disables everything.
  it("does not treat an absent console row as a disabled one", () => {
    expect(compareEntitlements([], { pro: { sso: 0 } })).toEqual([
      { plan: "pro", feature: "sso", consoleValue: null, productValue: 0 },
    ]);
  });

  // The same invariant one axis over: a whole PLAN the console never seeded is
  // reported cell by cell, not silently skipped because the plan key is
  // absent from one side's map.
  it("reports every cell of a plan the console lacks entirely", () => {
    expect(compareEntitlements(agreeing, { ...matrix, starter: { stores: 1, sso: 0 } })).toEqual([
      { plan: "starter", feature: "sso", consoleValue: null, productValue: 0 },
      { plan: "starter", feature: "stores", consoleValue: null, productValue: 1 },
    ]);
  });

  it("reports every cell of a plan only the console has", () => {
    expect(
      compareEntitlements([...agreeing, { plan: "marketplace", feature: "stores", value: 0 }], matrix),
    ).toEqual([{ plan: "marketplace", feature: "stores", consoleValue: 0, productValue: null }]);
  });

  // Deterministic order, so two runs of the same drift store the same report
  // and an operator diffing two rows sees the drift and not a reshuffle.
  it("orders differences by plan, then feature", () => {
    const differences = compareEntitlements(
      [],
      { starter: { stores: 1 }, pro: { sso: 1, stores: -1 } },
    );
    expect(differences.map((d) => `${d.plan}.${d.feature}`)).toEqual([
      "pro.sso",
      "pro.stores",
      "starter.stores",
    ]);
  });
});
