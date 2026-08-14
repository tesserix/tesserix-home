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
