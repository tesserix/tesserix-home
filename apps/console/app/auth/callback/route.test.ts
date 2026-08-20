import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionClaims } from "@tesserix/platform-auth";

// What this file is about: the session cookie the callback hands the browser.
//
// Two things, and they are the two halves of the same bug
// (`.planning/debug/console-login-state-mismatch.md`):
//
//   1. the Zitadel access/refresh tokens are NOT in the claims any more, and
//   2. a cookie that would exceed the browser's 4096-byte limit is refused
//      rather than set, because a browser over that limit discards the
//      `Set-Cookie` in silence and the server never learns.
//
// Zitadel, JWE and the OIDC round trip are mocked; they have their own tests.
// `measureSessionCookie` and `sessionCookieName` are the REAL implementations,
// so the size assertions are measuring what production measures.

const state = vi.hoisted(() => ({
  /**
   * Claims the route passed to signSession on the last run.
   *
   * Typed as the real `SessionClaims` (not a loose `Record<string, unknown>`)
   * so that reading `.sid` off it is checked against the actual optional
   * field a later task relies on, rather than an index signature that would
   * silently accept anything.
   */
  claims: null as SessionClaims | null,
  /** What signSession pretends the encrypted cookie value is. */
  sessionValue: "session-token",
  /** Every call `saveTokens` received, in order. */
  saveTokensCalls: [] as Array<{
    sid: string;
    sub: string;
    tokens: {
      accessToken: string;
      accessExpiresAt: Date;
      refreshToken?: string | null;
    };
    sessionExpiresAt: Date;
  }>,
  /** Swap in a throwing implementation to test the store-failure path. */
  saveTokensShouldThrow: false,
  /** Swap in a never-resolving implementation to test the deadline path. */
  saveTokensShouldHang: false,
  /** What `exchangeCode` returns. Overridable per test. */
  exchangeCodeResponse: {
    id_token: "id-token",
    access_token: "A".repeat(1200),
    refresh_token: "R".repeat(1200),
    expires_in: 3600,
  } as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  },
}));

// `importOriginal` keeps every real export (`accessTokenExpiresAt`,
// `readTokens`, `deleteTokens`, ...) intact and overrides only `saveTokens` —
// so `route.ts`'s own call to `accessTokenExpiresAt` runs the real arithmetic,
// and any module that imports it still sees a working one. (`withDeadline`
// itself lives in `lib/auth/deadline.ts` and is never mocked here — the
// deadline test below needs the real timer.)
//
// `saveTokens` below is typed as `typeof actual.saveTokens`: a future
// reordering of its parameters now fails to typecheck here instead of
// silently writing `sub` into the `sid` column.
//
// A plain async function, deliberately not `vi.fn(...)`: this module's
// `beforeEach` calls `vi.restoreAllMocks()`, which replaces a `vi.fn`'s
// implementation with a no-op the first time it runs — silently discarding
// the behavior below after the first test. Reading `state` at call time gets
// the same per-test control without that trap.
vi.mock("@/lib/auth/operator-token-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/operator-token-store")>();
  const saveTokens: typeof actual.saveTokens = async (
    sid,
    sub,
    tokens,
    sessionExpiresAt,
  ) => {
    if (state.saveTokensShouldThrow) {
      throw new Error("store unavailable");
    }
    if (state.saveTokensShouldHang) {
      // Never resolves and never rejects — the only way to prove the
      // deadline, not the store, is what ends the wait.
      await new Promise<void>(() => {});
      return;
    }
    state.saveTokensCalls.push({ sid, sub, tokens, sessionExpiresAt });
  };
  return { ...actual, saveTokens };
});

vi.mock("@tesserix/platform-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tesserix/platform-auth")>();
  return {
    ...actual,
    verifyIdToken: async () => ({
      sub: "operator-1",
      email: "operator@tesserix.test",
      name: "Operator One",
      orgId: "org-1",
      roles: Array.from({ length: 10 }, (_, i) => `role-${i}`),
    }),
    isInternal: () => true,
    toCapabilities: (roles: readonly string[]) => roles,
    signSession: async (claims: SessionClaims) => {
      state.claims = claims;
      return state.sessionValue;
    },
  };
});

vi.mock("@/lib/auth/oidc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/oidc")>();
  return {
    ...actual,
    getOidcConfig: () => ({
      issuer: "https://auth.test",
      clientId: "console-web",
      clientSecret: "secret",
      redirectUri: "https://console.tesserix.app/auth/callback",
      projectId: "p-1",
    }),
    exchangeCode: async () => state.exchangeCodeResponse,
  };
});

const NONCE = "nonce-value";
const STATE = `${NONCE}.${Buffer.from("/").toString("base64url")}`;

function callbackRequest(): NextRequest {
  return new NextRequest(
    `https://console.tesserix.app/auth/callback?code=auth-code&state=${STATE}`,
    {
      headers: {
        cookie: `cx_oauth_state=${NONCE}; cx_oidc_nonce=${NONCE}`,
        host: "console.tesserix.app",
      },
    },
  );
}

async function runCallback(): Promise<Response> {
  const { GET } = await import("./route");
  return GET(callbackRequest());
}

beforeEach(() => {
  state.claims = null;
  state.sessionValue = "session-token";
  state.saveTokensCalls = [];
  state.saveTokensShouldThrow = false;
  state.saveTokensShouldHang = false;
  state.exchangeCodeResponse = {
    id_token: "id-token",
    access_token: "A".repeat(1200),
    refresh_token: "R".repeat(1200),
    expires_in: 3600,
  };
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("the claims the callback mints", () => {
  it("does not put the Zitadel access or refresh token in the session", async () => {
    // The whole outage in one assertion. The token exchange above returns both
    // tokens; none of them may reach the cookie.
    await runCallback();

    expect(state.claims).not.toBeNull();
    expect(state.claims).not.toHaveProperty("accessToken");
    expect(state.claims).not.toHaveProperty("accessTokenExpiresAt");
    expect(state.claims).not.toHaveProperty("refreshToken");
  });

  it("still carries the identity the console authorizes on", async () => {
    // Removing the tokens must not quietly remove anything else: without
    // `roles` every operator loses every capability.
    await runCallback();

    expect(state.claims).toMatchObject({
      sub: "operator-1",
      email: "operator@tesserix.test",
      name: "Operator One",
    });
    expect(state.claims?.roles).toHaveLength(10);
  });

  it("mints a sid", async () => {
    await runCallback();

    expect(typeof state.claims?.sid).toBe("string");
    expect((state.claims?.sid as string).length).toBeGreaterThan(0);
  });

  it("mints a different sid on each call", async () => {
    // Deliberately does NOT reset `state.claims` to `null` between calls:
    // `signSession` (mocked above) overwrites it on every call anyway, and an
    // explicit `state.claims = null` here would let TypeScript narrow the
    // property to the literal `null` at that point in the control flow —
    // the compiler then refuses `.sid` on the "never" left over once `null`
    // is excluded, even though the mock reassigns it moments later.
    const { GET } = await import("./route");

    await GET(callbackRequest());
    const first = state.claims?.sid;

    await GET(callbackRequest());
    const second = state.claims?.sid;

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it("sets the session cookie and redirects on success", async () => {
    const res = await runCallback();

    expect(res.status).toBe(307);
    expect(res.headers.get("set-cookie")).toContain("tx_session=session-token");
  });
});

describe("the size guard", () => {
  it("refuses to mint a cookie the browser would discard", async () => {
    // A browser silently drops a `Set-Cookie` over 4096 bytes. Setting it
    // anyway is what produced seven "session minted" lines and zero sessions.
    state.sessionValue = "x".repeat(4097);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runCallback();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "session_too_large" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(error).toHaveBeenCalledWith(
      "[auth/callback] session cookie exceeds the browser limit",
      expect.objectContaining({ bytes: 4097 + "tx_session".length }),
    );
  });

  it("reports the byte count and the overshoot, never the cookie value", async () => {
    // The log line is the entire diagnosis for the next occurrence, and it is
    // also a place a session cookie must never end up.
    state.sessionValue = "x".repeat(5000);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runCallback();

    const [, detail] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(detail).toMatchObject({ limit: 4096, roleCount: 10 });
    expect(detail.overBy).toBe(5000 + "tx_session".length - 4096);
    expect(JSON.stringify(detail)).not.toContain("x".repeat(20));
  });

  it("shouts, but still mints, when the cookie is close to the limit", async () => {
    // Fits today, for this operator. The point of the band is that the next
    // operator with more roles is not the one who discovers the ceiling.
    state.sessionValue = "x".repeat(4000);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runCallback();

    expect(res.status).toBe(307);
    expect(res.headers.get("set-cookie")).toContain("tx_session=");
    expect(error).toHaveBeenCalledWith(
      "[auth/callback] session cookie is close to the browser limit",
      expect.objectContaining({ headroom: 4096 - 4000 - "tx_session".length }),
    );
  });

  it("says nothing about size when the cookie is comfortably small", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runCallback();

    expect(res.status).toBe(307);
    expect(error).not.toHaveBeenCalled();
  });

  it("records the byte count on a successful mint", async () => {
    // A size that creeps up release by release is only visible if it is
    // recorded while nothing is wrong.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await runCallback();

    expect(info).toHaveBeenCalledWith(
      "[auth/callback] session minted",
      expect.objectContaining({
        cookieBytes: "session-token".length + "tx_session".length,
        cookieLimit: 4096,
      }),
    );
  });
});

describe("writing the platform API tokens to the store", () => {
  it("saves the row with the sid minted into the session, the sub, and the expiry", async () => {
    const before = Date.now();
    await runCallback();
    const after = Date.now();

    expect(state.saveTokensCalls).toHaveLength(1);
    const call = state.saveTokensCalls[0]!;

    // The exact sid the cookie's claims carry — not merely "a string" — so a
    // regression that mints two different sids (one for the cookie, one for
    // the row) is caught rather than passing on shape alone.
    expect(call.sid).toBe(state.claims?.sid);
    expect(call.sub).toBe("operator-1");
    expect(call.tokens.accessToken).toBe("A".repeat(1200));

    // expires_in: 3600 from the mocked exchange, computed at the moment of
    // exchange — bounded rather than pinned to a single millisecond so the
    // test is not flaky.
    const expiresAtMs = call.tokens.accessExpiresAt.getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it("mirrors the session cookie's own lifetime in session_expires_at", async () => {
    const before = Date.now();
    await runCallback();
    const after = Date.now();

    const call = state.saveTokensCalls[0]!;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const sessionExpiresMs = call.sessionExpiresAt.getTime();
    expect(sessionExpiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(sessionExpiresMs).toBeLessThanOrEqual(after + sevenDaysMs);
  });

  it("stores the refresh token returned by the exchange", async () => {
    await runCallback();

    expect(state.saveTokensCalls[0]?.tokens.refreshToken).toBe(
      "R".repeat(1200),
    );
  });

  it("stores a missing refresh token as absent, not as an empty string", async () => {
    state.exchangeCodeResponse = {
      id_token: "id-token",
      access_token: "A".repeat(1200),
      // No refresh_token at all — the case Zitadel produces when the
      // application has no Refresh Token grant configured.
      expires_in: 3600,
    };

    await runCallback();

    const stored = state.saveTokensCalls[0]?.tokens.refreshToken;
    expect(stored).not.toBe("");
    expect(stored == null).toBe(true);
  });

  it("still mints the session and redirects when the store throws", async () => {
    // The one rule that matters most: a database blip must never turn into a
    // failed login. Assert the actual observable outcome for the browser —
    // the redirect and the Set-Cookie — not merely that the call didn't
    // throw.
    state.saveTokensShouldThrow = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runCallback();

    expect(res.status).toBe(307);
    expect(res.headers.get("set-cookie")).toContain("tx_session=session-token");
    expect(res.headers.get("location")).toBe("https://console.tesserix.app/");
    expect(error).toHaveBeenCalledWith(
      "[auth/callback] failed to store platform API tokens",
      expect.objectContaining({ sub: "operator-1" }),
    );
  });

  it(
    "still mints the session and redirects when the store hangs past its deadline",
    async () => {
      // The critical guarantee the throw test above does NOT cover: a store
      // that never settles — an unreachable-but-not-refusing Postgres, or an
      // INSERT stuck behind a lock — must not hang the login either. The
      // deadline (SAVE_TOKENS_DEADLINE_MS = 2000ms in route.ts), not the
      // store, is what has to end the wait — the mocked `saveTokens` below
      // never resolves on its own.
      //
      // Real timers, deliberately: `withDeadline`'s `setTimeout` and this
      // test's wall clock have to be the same clock for "the deadline fired"
      // to be a fact about the code rather than an artifact of how far fake
      // time was advanced relative to when the timer was actually armed.
      state.saveTokensShouldHang = true;
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await runCallback();

      expect(res.status).toBe(307);
      expect(res.headers.get("set-cookie")).toContain(
        "tx_session=session-token",
      );
      // A DISTINCT line from the throw case above. `saveTokens` prunes after
      // its INSERT has committed, so a deadline that fires may well have left
      // the row written — telling the reader it "failed to store" would send
      // them after the wrong outage.
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
        expect.objectContaining({ sub: "operator-1" }),
      );
    },
    { timeout: 6_000 },
  );

  it("does not store anything when the exchange returns no access token", async () => {
    state.exchangeCodeResponse = {
      id_token: "id-token",
      expires_in: 3600,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runCallback();

    expect(res.status).toBe(307);
    expect(state.saveTokensCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no access token"),
      expect.objectContaining({ sub: "operator-1" }),
    );
  });
});
