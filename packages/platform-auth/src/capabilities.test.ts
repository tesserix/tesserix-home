import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CONSOLE_ENTRY_CAPABILITY,
  CapabilityError,
  RISK_CAPABILITIES,
  SURFACE_CAPABILITIES,
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
    //
    // #261 ADDS FOUR. This list may only be updated once the roles exist in
    // Zitadel AND are granted, because enforcement is already live —
    // `AUTH_PROVIDER=zitadel` is set on the console deployment, so
    // `requiresCapability()` returns true and `checkOperatorCapability` denies
    // for real. A capability named here but ungranted there is not a pending
    // migration; it is a locked-out operator.
    //
    // There is a second step people forget: roles are copied into the
    // `tx_session` JWE AT LOGIN and sessions last 7 days, so granting in
    // Zitadel does not reach a live session. Operators must sign out and back
    // in before a new capability takes effect.
    expect([...CAPABILITIES]).toEqual([
      "read",
      "crm",
      "support",
      "billing",
      "platform",
      "respond",
      "rotate-credentials",
      "adjust-balance",
      "execute-refund",
      "mass-send",
      "hard-delete",
      "publish-catalog",
    ]);
  });

  it("uses read as the console entry ticket", () => {
    expect(CONSOLE_ENTRY_CAPABILITY).toBe("read");
  });
});

describe("the surface/verb split (#261)", () => {
  it("accounts for every capability as either entry, a surface, or a verb", () => {
    // A capability in none of the three buckets is one nobody has decided the
    // shape of — and an undecided capability is one that gets gated on by
    // guesswork.
    const classified = new Set<string>([
      CONSOLE_ENTRY_CAPABILITY,
      ...SURFACE_CAPABILITIES,
      ...RISK_CAPABILITIES,
    ]);

    expect([...CAPABILITIES].sort()).toEqual(Array.from(classified).sort());
  });

  it("keeps surfaces and verbs disjoint", () => {
    // The orthogonality rule: a capability says WHERE or WHAT, never both.
    // `respond` was the one at risk of being both, which is why #261 split it
    // from `support`.
    const overlap = SURFACE_CAPABILITIES.filter((s) =>
      (RISK_CAPABILITIES as readonly string[]).includes(s),
    );

    expect(overlap).toEqual([]);
  });

  it("keeps `read` out of both buckets — it is entry, not a surface", () => {
    expect(SURFACE_CAPABILITIES).not.toContain(CONSOLE_ENTRY_CAPABILITY);
    expect(RISK_CAPABILITIES).not.toContain(CONSOLE_ENTRY_CAPABILITY);
  });

  it("keeps `support` and `respond` separate", () => {
    // Collapsing them would make "can see the ticket queue" and "can answer a
    // merchant" the same permission. routes.ts already relies on the split:
    // platform.tickets carries no `respond`, platform.liveChat does.
    expect(SURFACE_CAPABILITIES).toContain("support");
    expect(RISK_CAPABILITIES).toContain("respond");
  });

  it("still grants nothing on an unknown role", () => {
    // The new capabilities must not have widened the boundary: anything not in
    // CAPABILITIES is still dropped rather than carried through.
    expect(toCapabilities(["crm", "not-a-capability", "support"])).toEqual([
      "crm",
      "support",
    ]);
  });

  it("does not let a surface capability satisfy a verb, or the reverse", () => {
    // The property the whole split exists for. Holding `crm` must not confer
    // `hard-delete`, and holding `hard-delete` must not confer `crm`.
    expect(hasCapability(["crm"], "hard-delete")).toBe(false);
    expect(hasCapability(["hard-delete"], "crm")).toBe(false);
  });
});

describe("publish-catalog capability", () => {
  it("treats publish-catalog as a risk verb, not a surface", () => {
    // Surfaces say WHERE, verbs say WHAT. Holding `billing` shows subscription
    // state; changing what mark8ly charges the world is a different question,
    // and gating publish on `billing` alone would silently upgrade every
    // existing billing grant without one of them being re-reviewed.
    expect(RISK_CAPABILITIES).toContain("publish-catalog");
  });

  it("does not admit a publish on the billing surface alone", () => {
    expect(hasCapability(["billing"], "publish-catalog")).toBe(false);
    expect(hasCapability(["billing", "publish-catalog"], "publish-catalog")).toBe(true);
  });
});
