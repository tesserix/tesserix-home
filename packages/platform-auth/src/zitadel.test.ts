import { describe, expect, it } from "vitest";
import { extractRoles, isInternal } from "./zitadel";

describe("extractRoles", () => {
  it("reads role keys from Zitadel's claim shape", () => {
    // Zitadel nests the granting org under each role key.
    expect(
      extractRoles({
        read: { "123456789": "tesserix.tesserix.app" },
        "execute-refund": { "123456789": "tesserix.tesserix.app" },
      }),
    ).toEqual(["read", "execute-refund"]);
  });

  it.each([
    ["undefined — the claim is absent", undefined],
    ["null", null],
    ["an array", ["read"]],
    ["a string", "read"],
    ["a number", 7],
  ])("returns no roles when the claim is %s", (_label, claim) => {
    expect(extractRoles(claim)).toEqual([]);
  });

  it("returns no roles for an empty claim object", () => {
    // This is the shape produced when the project asserts roles but the user
    // has none — distinct from the claim being missing entirely, and both must
    // land on "no roles" rather than throwing.
    expect(extractRoles({})).toEqual([]);
  });
});

describe("isInternal", () => {
  const INTERNAL_ORG = "123456789";

  it("denies an identity holding no roles", () => {
    // The console must not depend on Zitadel's "Only authorized users can
    // authenticate" checkbox staying ticked — it enforces the same rule here.
    expect(isInternal({ roles: [], orgId: INTERNAL_ORG }, {})).toBe(false);
  });

  it("admits an identity with roles when no org is configured", () => {
    expect(isInternal({ roles: ["read"], orgId: "other" }, {})).toBe(true);
  });

  it("admits an identity from the internal org", () => {
    expect(
      isInternal(
        { roles: ["read"], orgId: INTERNAL_ORG },
        { internalOrgId: INTERNAL_ORG },
      ),
    ).toBe(true);
  });

  it("denies an identity from another org even when it holds roles", () => {
    // The session cookie is scoped to .tesserix.app and shared with the
    // marketing app. If that app ever admits customers or tenants, their
    // cookie must not open the console.
    expect(
      isInternal(
        { roles: ["read"], orgId: "999" },
        { internalOrgId: INTERNAL_ORG },
      ),
    ).toBe(false);
  });

  it("denies an identity with no org when an internal org is required", () => {
    expect(
      isInternal({ roles: ["read"] }, { internalOrgId: INTERNAL_ORG }),
    ).toBe(false);
  });
});
