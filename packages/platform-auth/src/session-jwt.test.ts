import { createHash } from "node:crypto";
import { EncryptJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { measureSessionCookie } from "./session-cookie-size";
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
// These fields are DECODED but no longer WRITTEN. `/auth/callback` briefly put
// the Zitadel tokens here for D8 and it took the cookie over the browser's
// 4096-byte limit, which a browser enforces by silently discarding the whole
// `Set-Cookie` — so nobody could sign in at all. The tokens are moving to a
// server-side store keyed by a `sid` claim.
//
// The round-trip tests below therefore guard BACKWARD COMPATIBILITY, not a
// live path: sessions live 7 days, so sessions carrying these fields outlive
// the deploy that stopped writing them and must keep decoding.

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
    // The failure this guards is silent and total: a cookie over 4096 bytes is
    // DROPPED by the browser, so the operator lands back on the login page with
    // no error and no session — indistinguishable from a rejected credential.
    //
    // THIS TEST USED TO PASS WHILE PRODUCTION WAS BROKEN, and that is the
    // lesson worth keeping. It measured a HAND-BUILT access token, ~1.7KB,
    // "the realistic worst case". The real Zitadel access token was far
    // bigger, the real cookie cleared 4096, and Chrome discarded every
    // `Set-Cookie` the callback sent — seven logins in ten seconds, no session,
    // ERR_TOO_MANY_REDIRECTS. A budget test whose input is a guess measures the
    // guess. See `.planning/debug/console-login-state-mismatch.md`.
    //
    // So this now measures only what the callback ACTUALLY mints: identity.
    // No token material, nothing whose size is somebody's estimate. The
    // remaining variables — an email, a display name, one string per
    // capability — are all bounded and all here.
    const roles = [
      "read", "crm", "support", "billing", "platform", "respond",
      "rotate-credentials", "adjust-balance", "execute-refund", "mass-send", "hard-delete",
    ];

    const token = await signSession({
      sub: "386888878927118733", // a real Zitadel subject: 18 digits
      email: "an.operator.with.a.long.address@tesserix.example",
      name: "An Operator With A Reasonably Long Name",
      roles,
    });

    const measurement = measureSessionCookie("tx_session", token);
    expect(measurement.exceedsLimit).toBe(false);
    expect(measurement.nearLimit).toBe(false);
    // Asserted as headroom rather than as a magic ceiling: the number that
    // matters is how much room is left for whatever gets added next, and a
    // regression that eats it should fail here rather than in a browser.
    expect(measurement.headroom).toBeGreaterThan(3000);
  });

  it("does not grow with a role list unless the roles themselves grow", async () => {
    // The prod failure was on an operator with ten roles while the deploy was
    // tested with fewer, so the sensitivity of the size to the role count is
    // worth pinning rather than assuming.
    const one = await signSession({
      sub: "operator-1",
      email: "operator@tesserix.test",
      roles: ["read"],
    });
    const all = await signSession({
      sub: "operator-1",
      email: "operator@tesserix.test",
      roles: [
        "read", "crm", "support", "billing", "platform", "respond",
        "rotate-credentials", "adjust-balance", "execute-refund", "mass-send", "hard-delete",
      ],
    });

    const grew =
      measureSessionCookie("tx_session", all).bytes -
      measureSessionCookie("tx_session", one).bytes;

    // Every capability key in the model, added, costs well under a tenth of
    // the budget. Identity in the cookie is affordable; credentials were not.
    expect(grew).toBeGreaterThan(0);
    expect(grew).toBeLessThan(400);
  });
});
