import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CONSOLE_ENTRY_CAPABILITY,
  CapabilityError,
  MACHINE_CAPABILITIES,
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
      "read-plan-catalog",
      // #521. A MACHINE capability, which is why adding it here does not lock
      // an operator out the way the note above warns about: no operator holds
      // it and no console surface gates on it. The precondition it does carry
      // is on the other side — until the role exists on the Platform Console
      // project and is granted to a service user, `/api/v1/promo-catalog`
      // answers 403 to every caller.
      "read-promo-catalog",
      // #152. The third MACHINE capability, and the first that is not a
      // catalog read: it lets a product reach its OWN support tickets, which
      // is what mark8ly does today through apps/web's shared-secret
      // `/api/internal/platform-tickets`.
      //
      // Deliberately NOT `support`. That is an operator SURFACE and, per §7,
      // capabilities are estate-wide — granting it to a product's machine
      // would open every other product's ticket queue, and `respond` beside
      // it would open replying to them. Which product a holder may reach is
      // NOT decided here; see the subject->product registry, because a
      // capability string cannot carry a product and this one does not
      // pretend to.
      "product-support",
      // #152. A machine capability, so adding it locks no operator out.
      "read-announcements",
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
      ...MACHINE_CAPABILITIES,
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

describe("read-plan-catalog capability", () => {
  it("maps the plan-catalog read role to its capability", () => {
    expect(toCapabilities(["read-plan-catalog"])).toContain("read-plan-catalog");
  });

  it("does not grant the billing surface to a plan-catalog reader", () => {
    // A machine that reads published prices must not thereby hold the
    // console's billing surface. This is the whole reason the capability
    // exists.
    expect(toCapabilities(["read-plan-catalog"])).not.toContain("billing");
  });

  it("does not let the console-entry capability imply it", () => {
    expect(toCapabilities(["read"])).not.toContain("read-plan-catalog");
  });

  it("is classified as neither a surface nor a risk verb", () => {
    // It is a machine capability: it says nothing about WHERE an operator
    // works or WHAT they may do, because there is no operator.
    expect(SURFACE_CAPABILITIES).not.toContain("read-plan-catalog");
    expect(RISK_CAPABILITIES).not.toContain("read-plan-catalog");
    expect(MACHINE_CAPABILITIES).toContain("read-plan-catalog");
  });
});

describe("read-promo-catalog capability", () => {
  it("maps the promo-catalog read role to its capability", () => {
    expect(toCapabilities(["read-promo-catalog"])).toContain("read-promo-catalog");
  });

  it("is not implied by read-plan-catalog, in either direction", () => {
    // The two published contracts are separate grants. If holding one ever
    // starts admitting the other, a grant already made to a price reader
    // silently widens to every promo code in the estate.
    expect(hasCapability(["read-plan-catalog"], "read-promo-catalog")).toBe(false);
    expect(hasCapability(["read-promo-catalog"], "read-plan-catalog")).toBe(false);
  });

  it("does not grant the billing surface to a promo-catalog reader", () => {
    expect(toCapabilities(["read-promo-catalog"])).not.toContain("billing");
  });

  it("does not let the console-entry capability imply it", () => {
    expect(toCapabilities(["read"])).not.toContain("read-promo-catalog");
  });

  it("is classified as neither a surface nor a risk verb", () => {
    expect(SURFACE_CAPABILITIES).not.toContain("read-promo-catalog");
    expect(RISK_CAPABILITIES).not.toContain("read-promo-catalog");
    expect(MACHINE_CAPABILITIES).toContain("read-promo-catalog");
  });
});

describe("product-support capability", () => {
  it("maps the product support role to its capability", () => {
    expect(toCapabilities(["product-support"])).toContain("product-support");
  });

  it("does not grant the operator support surface", () => {
    // The whole reason this capability exists. `support` is estate-wide: a
    // product machine holding it could read every other product's queue.
    expect(hasCapability(["product-support"], "support")).toBe(false);
    expect(toCapabilities(["product-support"])).not.toContain("support");
  });

  it("is not granted BY the operator support surface either", () => {
    // The reverse direction matters too: an operator holding `support` reaches
    // the queue as an operator, not as some product's machine. If `support`
    // ever implied this, an operator would silently acquire whatever scoping
    // rule the registry applies to machines.
    expect(hasCapability(["support"], "product-support")).toBe(false);
  });

  it("does not imply respond", () => {
    // Filing and reading a product's own tickets is not the same grant as
    // transitioning their status. #261's surface/verb split, held for machines.
    expect(hasCapability(["product-support"], "respond")).toBe(false);
  });

  it("is not implied by the other machine capabilities, in either direction", () => {
    // A price reader has no business in a ticket queue, and a support caller
    // has none enumerating the estate's promo codes.
    expect(hasCapability(["read-plan-catalog"], "product-support")).toBe(false);
    expect(hasCapability(["read-promo-catalog"], "product-support")).toBe(false);
    expect(hasCapability(["product-support"], "read-plan-catalog")).toBe(false);
    expect(hasCapability(["product-support"], "read-promo-catalog")).toBe(false);
  });

  it("does not let the console-entry capability imply it", () => {
    expect(toCapabilities(["read"])).not.toContain("product-support");
  });

  it("is classified as a machine capability, neither surface nor risk verb", () => {
    expect(SURFACE_CAPABILITIES).not.toContain("product-support");
    expect(RISK_CAPABILITIES).not.toContain("product-support");
    expect(MACHINE_CAPABILITIES).toContain("product-support");
  });
});

describe("read-announcements capability", () => {
  it("maps the role to its capability", () => {
    expect(toCapabilities(["read-announcements"])).toContain("read-announcements");
  });

  it("is not implied by product-support, in either direction", () => {
    // A product showing a maintenance banner has no business in its
    // merchants' ticket queue, and a support caller need not read broadcasts.
    expect(hasCapability(["product-support"], "read-announcements")).toBe(false);
    expect(hasCapability(["read-announcements"], "product-support")).toBe(false);
  });

  it("does not grant any operator surface", () => {
    for (const surface of SURFACE_CAPABILITIES) {
      expect(hasCapability(["read-announcements"], surface)).toBe(false);
    }
  });

  it("is classified as a machine capability", () => {
    expect(SURFACE_CAPABILITIES).not.toContain("read-announcements");
    expect(RISK_CAPABILITIES).not.toContain("read-announcements");
    expect(MACHINE_CAPABILITIES).toContain("read-announcements");
  });
});
