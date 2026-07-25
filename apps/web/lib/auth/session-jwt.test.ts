import { beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "./session-jwt";

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
