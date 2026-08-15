import { describe, expect, it } from "vitest";
import { extractRoles, isInternal, verifyIdToken } from "./zitadel";

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

describe("verifyIdToken rejects before it trusts", () => {
  it("refuses a token that is not a JWT at all", async () => {
    // No network is reached: jwtVerify fails on the structure first, so this
    // also proves a malformed token cannot cause a JWKS fetch.
    await expect(
      verifyIdToken("not-a-jwt", {
        issuer: "https://auth.tesserix.app",
        clientId: "386382971877196703",
      }),
    ).rejects.toThrow();
  });

  it("refuses an unsigned token even when its claims look right", async () => {
    // `alg: none` with a plausible payload — the shape an attacker submits when
    // hoping the implementation decodes rather than verifies.
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: "1",
      email: "attacker@example.com",
      iss: "https://auth.tesserix.app",
      aud: "386382971877196703",
      "urn:zitadel:iam:org:project:roles": { "hard-delete": {} },
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    await expect(
      verifyIdToken(forged, {
        issuer: "https://auth.tesserix.app",
        clientId: "386382971877196703",
      }),
    ).rejects.toThrow();
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
