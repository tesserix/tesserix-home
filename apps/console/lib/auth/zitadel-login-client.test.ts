import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LoginClientError,
  checkSufficiency,
  createPasswordSession,
  finalize,
  getAuthRequest,
  getEnrolledFactors,
  getLoginPolicy,
  loginClientConfig,
} from "./zitadel-login-client";

const config = { issuer: "https://auth.test", token: "login-client-pat" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function respond(body: unknown, status = 200) {
  vi.stubGlobal("fetch", async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

describe("loginClientConfig", () => {
  it("is null when the token is absent", () => {
    // The console cannot host its own login without it. Null is answered with
    // "this deployment cannot host its own login", never with a credential
    // error — telling a user their password was wrong would be a lie.
    vi.stubEnv("ZITADEL_ISSUER", "https://auth.test");
    vi.stubEnv("ZITADEL_LOGIN_CLIENT_TOKEN", "");
    expect(loginClientConfig()).toBeNull();
  });

  it("is null when the issuer is absent", () => {
    vi.stubEnv("ZITADEL_ISSUER", "");
    vi.stubEnv("ZITADEL_LOGIN_CLIENT_TOKEN", "pat");
    expect(loginClientConfig()).toBeNull();
  });
});

describe("the login-client token", () => {
  it("is sent as a bearer and never appears in a thrown message", async () => {
    // It can check anyone's password and mint a session for anyone — the most
    // powerful credential this application holds.
    let seen: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen = { ...(init.headers as Record<string, string>) };
      return new Response("nope", { status: 500 });
    });

    await expect(getAuthRequest(config, "abc")).rejects.toThrow(LoginClientError);
    expect(seen.authorization).toBe("Bearer login-client-pat");
    await expect(getAuthRequest(config, "abc")).rejects.not.toThrow(/login-client-pat/);
  });
});

describe("createPasswordSession", () => {
  it("checks the login name and password in ONE request", async () => {
    // Splitting them would leak which half failed through timing alone.
    let body: unknown;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ sessionId: "s1", sessionToken: "t1" }), { status: 200 });
    });

    const session = await createPasswordSession(config, "operator@tesserix.test", "hunter2");

    expect(session).toEqual({ id: "s1", token: "t1" });
    expect(body).toEqual({
      checks: { user: { loginName: "operator@tesserix.test" }, password: { password: "hunter2" } },
    });
  });

  it("maps a rejected credential to bad-credentials", async () => {
    respond({ message: "Errors.User.Password.Invalid" }, 401);
    await expect(createPasswordSession(config, "a", "b")).rejects.toMatchObject({
      kind: "bad-credentials",
    });
  });
});

describe("failing closed", () => {
  it("treats an unreadable policy as forcing MFA", async () => {
    respond("boom", 500);
    const policy = await getLoginPolicy(config);
    expect(policy).toEqual({ forceMfa: true, forceMfaLocalOnly: true });
  });

  it("treats an unreadable factor list as unknown, not as none enrolled", async () => {
    // The improvised version of "we could not find out" is an empty array,
    // which decides "complete" and skips a factor the org configured.
    respond("boom", 500);
    const factors = await getEnrolledFactors(config, { id: "s1", token: "t1" });
    expect(checkSufficiency({ forceMfa: false, forceMfaLocalOnly: false }, factors).proof).toBeNull();
  });

  it("treats a session with no resolvable user as unknown", async () => {
    respond({ session: {} });
    const factors = await getEnrolledFactors(config, { id: "s1", token: "t1" });
    expect(checkSufficiency({ forceMfa: false, forceMfaLocalOnly: false }, factors).proof).toBeNull();
  });
});

describe("finalize", () => {
  it("cannot be called without the sufficiency proof", () => {
    // The guarantee this whole design rests on: Zitadel will NOT enforce MFA
    // for a login client, so a path that completes a login without deciding
    // whether a second factor was owed must not compile.
    // @ts-expect-error finalize requires a Sufficient proof
    void (() => finalize(config, "req", { id: "s", token: "t" }));
  });

  it("returns the callback URL when the proof is present", async () => {
    respond({ callbackUrl: "https://console.tesserix.app/auth/callback?code=abc&state=xyz" });
    const { proof } = checkSufficiency(
      { forceMfa: false, forceMfaLocalOnly: false },
      { secondFactorTypes: [], passkeyCount: 0 },
    );
    expect(proof).not.toBeNull();

    const url = await finalize(config, "req", { id: "s", token: "t" }, proof!);

    expect(url).toContain("/auth/callback?code=");
  });

  it("refuses a response with no callback url rather than redirecting nowhere", async () => {
    respond({});
    const { proof } = checkSufficiency(
      { forceMfa: false, forceMfaLocalOnly: false },
      { secondFactorTypes: [], passkeyCount: 0 },
    );
    await expect(finalize(config, "req", { id: "s", token: "t" }, proof!)).rejects.toThrow(
      LoginClientError,
    );
  });
});

describe("getAuthRequest", () => {
  it("rejects an auth request that does not exist", async () => {
    // A stale bookmark or an expired attempt. Distinct from a credential
    // failure so the page can say "start again" instead of "wrong password".
    respond({});
    await expect(getAuthRequest(config, "gone")).rejects.toMatchObject({ kind: "auth-request" });
  });
});
