import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  /** Claims the route passed to signSession on the last run. */
  claims: null as Record<string, unknown> | null,
  /** What signSession pretends the encrypted cookie value is. */
  sessionValue: "session-token",
}));

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
    signSession: async (claims: Record<string, unknown>) => {
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
    exchangeCode: async () => ({
      id_token: "id-token",
      access_token: "A".repeat(1200),
      refresh_token: "R".repeat(1200),
      expires_in: 3600,
    }),
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
