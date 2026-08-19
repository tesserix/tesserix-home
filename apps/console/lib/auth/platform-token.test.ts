import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session and the OIDC client are both mocked: this file is about the
// DECISION — use the stored token, renew it, or admit there is none — not
// about JWE or HTTP, which have their own tests.

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  refreshed: null as { access_token?: string } | null,
  refreshCalls: 0,
  configThrows: false,
}));

vi.mock("@tesserix/platform-auth", () => ({
  getCurrentSession: async () => state.session,
}));

vi.mock("./oidc", () => ({
  getOidcConfig: () => {
    if (state.configThrows) throw new Error("not configured");
    return { issuer: "https://auth.test", clientId: "c", clientSecret: "s" };
  },
  refreshAccessToken: async () => {
    state.refreshCalls += 1;
    return state.refreshed;
  },
}));

const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  state.session = null;
  state.refreshed = null;
  state.refreshCalls = 0;
  state.configThrows = false;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function getToken() {
  const { getPlatformApiToken } = await import("./platform-token");
  return getPlatformApiToken();
}

describe("getPlatformApiToken", () => {
  it("returns null when there is no session", async () => {
    expect(await getToken()).toBeNull();
  });

  it("returns null for a session minted before tokens were retained", async () => {
    // Sessions live 7 days, so they outlive the deploy that started keeping
    // them. Those operators must keep working everywhere else.
    state.session = { sub: "operator-1", email: "operator@tesserix.test", roles: ["read"] };

    expect(await getToken()).toBeNull();
    expect(state.refreshCalls).toBe(0);
  });

  it("returns a token that is still comfortably valid, without refreshing", async () => {
    state.session = {
      sub: "operator-1",
      accessToken: "still-good",
      accessTokenExpiresAt: now() + 3600,
      refreshToken: "r",
    };

    expect(await getToken()).toBe("still-good");
    expect(state.refreshCalls).toBe(0);
  });

  it("renews a token that expires imminently, before it is actually expired", async () => {
    // The window matters: a token valid for another ten seconds has to survive
    // this request, the hop to the platform API, and that service's clock.
    state.session = {
      sub: "operator-1",
      accessToken: "about-to-die",
      accessTokenExpiresAt: now() + 10,
      refreshToken: "r",
    };
    state.refreshed = { access_token: "renewed" };

    expect(await getToken()).toBe("renewed");
    expect(state.refreshCalls).toBe(1);
  });

  it("renews an already-expired token", async () => {
    state.session = {
      sub: "operator-1",
      accessToken: "dead",
      accessTokenExpiresAt: now() - 3600,
      refreshToken: "r",
    };
    state.refreshed = { access_token: "renewed" };

    expect(await getToken()).toBe("renewed");
  });

  it("treats an unknown expiry as expiring rather than as valid forever", async () => {
    // Zitadel omitting `expires_in` is rare, and the safe direction is to spend
    // a request rather than to hand out a token that may already be dead.
    state.session = { sub: "operator-1", accessToken: "unknown-expiry", refreshToken: "r" };
    state.refreshed = { access_token: "renewed" };

    expect(await getToken()).toBe("renewed");
    expect(state.refreshCalls).toBe(1);
  });

  it("returns null — never the dead token — when there is nothing to renew with", async () => {
    // The state the console is in today: `console-web` has no Refresh Token
    // grant, so Zitadel issues no refresh token. Handing back the expired one
    // would turn a clear local failure into a 401 from a service that has no
    // idea why either.
    state.session = {
      sub: "operator-1",
      accessToken: "dead",
      accessTokenExpiresAt: now() - 3600,
    };

    expect(await getToken()).toBeNull();
    expect(state.refreshCalls).toBe(0);
  });

  it("returns null when the refresh is rejected", async () => {
    // A revoked or rotated refresh token. That is "sign in again", not "the
    // console is broken", and it must not throw into a page render.
    state.session = {
      sub: "operator-1",
      accessToken: "dead",
      accessTokenExpiresAt: now() - 10,
      refreshToken: "revoked",
    };
    state.refreshed = null;

    expect(await getToken()).toBeNull();
  });

  it("returns null rather than throwing when Zitadel is not configured", async () => {
    state.session = {
      sub: "operator-1",
      accessToken: "dead",
      accessTokenExpiresAt: now() - 10,
      refreshToken: "r",
    };
    state.configThrows = true;

    await expect(getToken()).resolves.toBeNull();
  });

  it("does NOT memoise across requests, which is the property that matters", async () => {
    // React's `cache` is request-scoped, and this test environment has no
    // request scope — so the three calls below each do their own refresh. That
    // is exactly what should happen, and asserting it is worth more than
    // asserting the dedup:
    //
    // A module-level memo would be the obvious hand-rolled alternative, and it
    // would be a cross-operator token leak — one operator's access token
    // served to the next request that asked. The de-duplication is a
    // performance nicety; NOT sharing tokens between requests is a security
    // property, and it is the one a test can pin here.
    //
    // The in-request dedup that `cache` does provide is only observable inside
    // a render, which is where it matters: fetchTicketsFromPlatformApi reads
    // the listing and the summary with Promise.all in one server component.
    state.session = {
      sub: "operator-1",
      accessToken: "dead",
      accessTokenExpiresAt: now() - 10,
      refreshToken: "r",
    };
    state.refreshed = { access_token: "renewed" };

    const { getPlatformApiToken } = await import("./platform-token");
    await Promise.all([getPlatformApiToken(), getPlatformApiToken(), getPlatformApiToken()]);
    const outsideScope = state.refreshCalls;

    // A second "request": fresh module registry, a different operator.
    vi.resetModules();
    state.session = {
      sub: "operator-2",
      accessToken: "dead-2",
      accessTokenExpiresAt: now() - 10,
      refreshToken: "r2",
    };
    state.refreshed = { access_token: "renewed-for-operator-2" };
    const second = await getToken();

    expect(second).toBe("renewed-for-operator-2");
    expect(state.refreshCalls).toBeGreaterThan(outsideScope);
  });
});
