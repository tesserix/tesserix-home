import { createHash } from "node:crypto";
import { EncryptJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { signSession, verifySession } from "./session-jwt";

beforeAll(() => {
  process.env.SESSION_ENCRYPT_KEY = "test-session-key-please-change-32b";
});

// Helper to (re)load getCurrentSession with a mocked next/headers.
async function loadGetCurrentSession(opts: {
  cookie?: string;
  authorization?: string;
}) {
  vi.resetModules();
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) =>
        opts.cookie && name === (process.env.SESSION_COOKIE_NAME ?? "tx_session")
          ? { value: opts.cookie }
          : undefined,
    }),
    headers: async () => ({
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? opts.authorization ?? null : null,
    }),
  }));
  const mod = await import("./session-jwt");
  return mod.getCurrentSession;
}

// Key rotation to any length other than exactly 32 bytes takes the SHA-256
// derivation path. That path used to call `require("node:crypto")`, which the
// tsup ESM bundle rewrites into a shim that throws — meaning nothing could
// mint or verify a session. It is a static import now; this locks that in.
describe("key derivation", () => {
  it.each(["short", "a-much-longer-rotated-session-encryption-key-value"])(
    "signs and verifies with a rotated key that is not exactly 32 bytes: %s",
    async (key) => {
      const original = process.env.SESSION_ENCRYPT_KEY;
      process.env.SESSION_ENCRYPT_KEY = key;
      try {
        const token = await signSession({ sub: "u-rot", email: "rotate@tesserix.com" });
        expect(await verifySession(token)).toMatchObject({ sub: "u-rot" });
      } finally {
        process.env.SESSION_ENCRYPT_KEY = original;
      }
    },
  );
});

describe("getCurrentSession", () => {
  it("resolves the session from an Authorization: Bearer token when no cookie is present", async () => {
    const token = await signSession({ sub: "u-1", email: "ops@tesserix.com", name: "Ops" });
    const getCurrentSession = await loadGetCurrentSession({ authorization: `Bearer ${token}` });
    const session = await getCurrentSession();
    expect(session?.email).toBe("ops@tesserix.com");
    expect(session?.sub).toBe("u-1");
  });

  it("still resolves from the cookie (web path unchanged)", async () => {
    const token = await signSession({ sub: "u-2", email: "web@tesserix.com" });
    const getCurrentSession = await loadGetCurrentSession({ cookie: token });
    const session = await getCurrentSession();
    expect(session?.email).toBe("web@tesserix.com");
  });

  it("returns null when neither cookie nor bearer is present", async () => {
    const getCurrentSession = await loadGetCurrentSession({});
    expect(await getCurrentSession()).toBeNull();
  });
});

// ---- the platform API's access token (ADR-003 D8) -----------------------
//
// The console kept only the ID token and dropped `access_token` and
// `refresh_token` on the floor. The platform API takes a Zitadel access token,
// so until the session carries one the console cannot call it at all — which is
// why the tickets module ships behind PLATFORM_API_ORIGIN.

describe("platform API tokens in the session", () => {
  it("carries an access token, its expiry and a refresh token through a round trip", async () => {
    const token = await signSession({
      sub: "operator-1",
      email: "operator@tesserix.test",
      roles: ["read", "support"],
      accessToken: "zitadel-access-token",
      refreshToken: "zitadel-refresh-token",
      accessTokenExpiresAt: 1_800_000_000,
    });

    const session = await verifySession(token);

    expect(session?.accessToken).toBe("zitadel-access-token");
    expect(session?.refreshToken).toBe("zitadel-refresh-token");
    expect(session?.accessTokenExpiresAt).toBe(1_800_000_000);
  });

  it("still verifies a session minted without them", async () => {
    // Every session issued before this shipped, and every mobile session. They
    // must keep working — the fields are additive, and a console that refused
    // them would log everyone out on deploy.
    const token = await signSession({ sub: "operator-1", email: "operator@tesserix.test" });

    const session = await verifySession(token);

    expect(session).not.toBeNull();
    expect(session?.accessToken).toBeUndefined();
    expect(session?.refreshToken).toBeUndefined();
    expect(session?.accessTokenExpiresAt).toBeUndefined();
  });

  it("treats a malformed token field as absent rather than as a value", async () => {
    // Same policy `roles` follows: absent lets the caller decide, whereas a
    // non-string coerced into place would be sent to the platform API as a
    // bearer credential and rejected with nothing useful in the message.
    const key = createHash("sha256").update(process.env.SESSION_ENCRYPT_KEY!).digest();
    const token = await new EncryptJWT({
      sub: "operator-1",
      email: "operator@tesserix.test",
      accessToken: { not: "a string" },
      accessTokenExpiresAt: "soon",
    })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setIssuer("tesserix-home")
      .setAudience("tesserix-home-admin")
      .setExpirationTime("7d")
      .encrypt(key);

    const session = await verifySession(token);

    expect(session).not.toBeNull();
    expect(session?.accessToken).toBeUndefined();
    expect(session?.accessTokenExpiresAt).toBeUndefined();
  });

  it("keeps the encoded session inside a browser's per-cookie budget", async () => {
    // The failure this guards is silent and total: a cookie over ~4KB is
    // DROPPED by the browser, so the operator lands back on the login page with
    // no error and no session — indistinguishable from a rejected credential.
    //
    // A Zitadel access token carrying eleven role keys is the realistic worst
    // case here, so it is what this measures.
    const roles = [
      "read", "crm", "support", "billing", "platform", "respond",
      "rotate-credentials", "adjust-balance", "execute-refund", "mass-send", "hard-delete",
    ];
    const fatAccessToken = `${"h".repeat(64)}.${Buffer.from(
      JSON.stringify({ sub: "operator-1", roles, aud: ["386377618200461939"] }),
    ).toString("base64url")}${"p".repeat(1200)}.${"s".repeat(342)}`;

    const token = await signSession({
      sub: "operator-1",
      email: "operator@tesserix.test",
      name: "An Operator With A Reasonably Long Name",
      roles,
      accessToken: fatAccessToken,
      refreshToken: "r".repeat(96),
      accessTokenExpiresAt: 1_800_000_000,
    });

    // 4096 is the per-cookie limit browsers converge on, and the name and
    // attributes count against it too — hence the margin.
    expect(token.length).toBeLessThan(3800);
  });
});
