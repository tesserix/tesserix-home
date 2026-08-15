import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CONSOLE_ENTRY_CAPABILITY,
  CapabilityError,
  assertCapability,
  hasCapability,
  toCapabilities,
} from "./capabilities";

describe("hasCapability fails closed", () => {
  // Each of these is a shape that a permissive implementation would let
  // through. The defect this module replaces was precisely "no check at all
  // reads as allowed", so the degenerate cases matter more than the happy one.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", [] as string[]],
  ])("denies when held is %s", (_label, held) => {
    expect(hasCapability(held, "read")).toBe(false);
  });

  it("denies a capability the operator does not hold", () => {
    expect(hasCapability(["read", "respond"], "hard-delete")).toBe(false);
  });

  it("allows a capability the operator does hold", () => {
    expect(hasCapability(["read", "execute-refund"], "execute-refund")).toBe(
      true,
    );
  });

  it("has no superuser short-circuit", () => {
    // An `admin`-style role must NOT satisfy an unrelated capability. If it
    // ever does, the seven granular roles become decoration and the flat model
    // this replaces is back.
    for (const wildcard of ["admin", "*", "superuser", "owner"]) {
      expect(hasCapability([wildcard], "rotate-credentials")).toBe(false);
    }
  });

  it("rejects a required capability outside the known set", () => {
    // Guards against a typo'd literal silently passing because the token
    // happens to carry the same typo.
    expect(hasCapability(["not-a-capability"], "not-a-capability" as never)).toBe(
      false,
    );
  });
});

describe("toCapabilities", () => {
  it("drops unknown roles rather than carrying them", () => {
    expect(toCapabilities(["read", "invented", "hard-delete"])).toEqual([
      "read",
      "hard-delete",
    ]);
  });

  it("returns empty for an empty input", () => {
    expect(toCapabilities([])).toEqual([]);
  });
});

describe("assertCapability", () => {
  it("throws CapabilityError naming the missing capability", () => {
    expect(() => assertCapability(["read"], "adjust-balance")).toThrowError(
      CapabilityError,
    );
    try {
      assertCapability(["read"], "adjust-balance");
      expect.unreachable("assertCapability should have thrown");
    } catch (err) {
      expect((err as CapabilityError).required).toBe("adjust-balance");
    }
  });

  it("does not throw when the capability is held", () => {
    expect(() => assertCapability(["mass-send"], "mass-send")).not.toThrow();
  });

  it("throws for every capability when nothing is held", () => {
    for (const cap of CAPABILITIES) {
      expect(() => assertCapability([], cap)).toThrowError(CapabilityError);
    }
  });
});

describe("the capability set is a contract with Zitadel", () => {
  it("matches the role keys defined on the Platform Console project", () => {
    // These strings are the project's role keys. Changing one here without
    // changing it in Zitadel silently revokes access: the token keeps carrying
    // the old key, and every check for the new one denies.
    expect([...CAPABILITIES]).toEqual([
      "read",
      "respond",
      "rotate-credentials",
      "adjust-balance",
      "execute-refund",
      "mass-send",
      "hard-delete",
    ]);
  });

  it("uses read as the console entry ticket", () => {
    expect(CONSOLE_ENTRY_CAPABILITY).toBe("read");
  });
});
