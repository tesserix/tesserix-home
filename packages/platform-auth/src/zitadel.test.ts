import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  MachineTokenError,
  extractRoles,
  isInternal,
  verifyIdToken,
  verifyMachineAuthHeader,
} from "./zitadel";

// ---------------------------------------------------------------------
// JWKS/signing test harness — shared by every suite in this file that needs
// a token verifiable against a real (local) JWKS endpoint rather than a
// forged/unsigned one. Runs `createRemoteJWKSet`'s actual fetch path against
// a throwaway HTTP server instead of mocking it, so these tests exercise the
// same code a production request does.
// ---------------------------------------------------------------------

/** jose's key type, kept as an alias so tests don't need the DOM `CryptoKey` lib. */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let activeServer: Server | undefined;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer?.close(() => resolve()));
    activeServer = undefined;
  }
});

/** Start a local JWKS endpoint serving one RS256 keypair's public half. */
async function startJwks(): Promise<{
  issuer: string;
  privateKey: PrivateKey;
  kid: string;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "test-key";
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

  const server = createServer((req, res) => {
    if (req.url === "/oauth/v2/keys") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  activeServer = server;

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { issuer: `http://127.0.0.1:${port}`, privateKey, kid };
}

/** Sign a token with the given key, defaulting to claims a machine token carries. */
async function signToken(
  privateKey: PrivateKey,
  kid: string,
  overrides: {
    issuer: string;
    audience: string;
    sub?: string;
    roles?: Record<string, unknown>;
    orgId?: string;
    expiresAtSeconds?: number;
  },
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (overrides.roles) claims["urn:zitadel:iam:org:project:roles"] = overrides.roles;
  if (overrides.orgId) claims["urn:zitadel:iam:org:id"] = overrides.orgId;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject(overrides.sub ?? "service-user-1")
    .setIssuer(overrides.issuer)
    .setAudience(overrides.audience)
    .setIssuedAt()
    .setExpirationTime(
      overrides.expiresAtSeconds ?? Math.floor(Date.now() / 1000) + 3600,
    )
    .sign(privateKey);
}

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

describe("verifyMachineAuthHeader", () => {
  const MACHINE_AUDIENCE = "machine-api-resource-id";

  it("verifies a valid machine token and returns its roles", async () => {
    const { issuer, privateKey, kid } = await startJwks();
    const token = await signToken(privateKey, kid, {
      issuer,
      audience: MACHINE_AUDIENCE,
      sub: "service-user-1",
      roles: { "read-plan-catalog": { "123456789": "tesserix.tesserix.app" } },
      orgId: "123456789",
    });

    const identity = await verifyMachineAuthHeader(`Bearer ${token}`, {
      issuer,
      audience: MACHINE_AUDIENCE,
    });

    expect(identity.sub).toBe("service-user-1");
    expect(identity.roles).toEqual(["read-plan-catalog"]);
    expect(identity.orgId).toBe("123456789");
  });

  it("rejects a token minted for a different audience", async () => {
    const { issuer, privateKey, kid } = await startJwks();
    const token = await signToken(privateKey, kid, {
      issuer,
      audience: "some-other-resource",
    });

    await expect(
      verifyMachineAuthHeader(`Bearer ${token}`, {
        issuer,
        audience: MACHINE_AUDIENCE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-token" });
  });

  it("rejects a token with no audience at all", async () => {
    const { issuer, privateKey, kid } = await startJwks();
    // Sign directly, bypassing setAudience, to produce a token with no `aud`.
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject("service-user-1")
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await expect(
      verifyMachineAuthHeader(`Bearer ${token}`, {
        issuer,
        audience: MACHINE_AUDIENCE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-token" });
  });

  it("rejects an expired token", async () => {
    const { issuer, privateKey, kid } = await startJwks();
    const token = await signToken(privateKey, kid, {
      issuer,
      audience: MACHINE_AUDIENCE,
      expiresAtSeconds: Math.floor(Date.now() / 1000) - 60,
    });

    await expect(
      verifyMachineAuthHeader(`Bearer ${token}`, {
        issuer,
        audience: MACHINE_AUDIENCE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-token" });
  });

  it("rejects a token signed by the wrong key", async () => {
    const { issuer, kid } = await startJwks();
    // A different keypair than the one published at this issuer's JWKS —
    // the signature will not verify against the published public key.
    const { privateKey: wrongKey } = await generateKeyPair("RS256");
    const token = await signToken(wrongKey, kid, {
      issuer,
      audience: MACHINE_AUDIENCE,
    });

    await expect(
      verifyMachineAuthHeader(`Bearer ${token}`, {
        issuer,
        audience: MACHINE_AUDIENCE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-token" });
  });

  it("rejects a malformed or absent Authorization header, distinctly from an invalid token", async () => {
    const config = { issuer: "https://auth.tesserix.app", audience: MACHINE_AUDIENCE };

    for (const header of [undefined, null, "", "Bearer", "Basic abc123"]) {
      await expect(
        verifyMachineAuthHeader(header, config),
      ).rejects.toMatchObject({ reason: "missing-token" });
    }

    // Confirm the two reasons are actually distinguishable, not just two
    // strings that happen to both be present on the type.
    const { issuer, privateKey, kid } = await startJwks();
    const expired = await signToken(privateKey, kid, {
      issuer,
      audience: MACHINE_AUDIENCE,
      expiresAtSeconds: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(
      verifyMachineAuthHeader(`Bearer ${expired}`, { issuer, audience: MACHINE_AUDIENCE }),
    ).rejects.toMatchObject({ reason: "invalid-token" });
  });

  it("rejects an absent header with a MachineTokenError instance", async () => {
    try {
      await verifyMachineAuthHeader(undefined, {
        issuer: "https://auth.tesserix.app",
        audience: MACHINE_AUDIENCE,
      });
      expect.unreachable("verifyMachineAuthHeader should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MachineTokenError);
      expect((err as MachineTokenError).reason).toBe("missing-token");
    }
  });

  it("asserts operator-token behaviour: an ID token minted for apps/web is rejected here", async () => {
    // An operator's ID token carries `aud = ZITADEL_CLIENT_ID` (apps/web),
    // never the machine audience configured for this route. The audience
    // check that protects the route also means an operator token, if it ever
    // reached this function, is rejected rather than silently accepted —
    // asserted here rather than left undefined.
    const { issuer, privateKey, kid } = await startJwks();
    const operatorClientId = "386382971877196703";
    const operatorToken = await signToken(privateKey, kid, {
      issuer,
      audience: operatorClientId,
      sub: "operator-1",
      roles: { read: { "123456789": "tesserix.tesserix.app" } },
    });

    await expect(
      verifyMachineAuthHeader(`Bearer ${operatorToken}`, {
        issuer,
        audience: MACHINE_AUDIENCE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-token" });

    // And the same token verifies fine as an operator identity when checked
    // against the audience it was actually minted for — proving the failure
    // above is specifically the audience mismatch, not something wrong with
    // the token itself.
    await expect(
      verifyIdToken(operatorToken, { issuer, clientId: operatorClientId }),
    ).rejects.toThrow(/email/);
  });
});
