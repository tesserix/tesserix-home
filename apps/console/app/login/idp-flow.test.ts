import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Continue with Google", end to end across the two route handlers.
 *
 * The federated path leaves the console entirely and comes back, so the thing
 * these tests pin is what survives the round trip and what does not:
 *
 *   - the auth request the login started with, which must come back from a
 *     cookie rather than from the query string a provider redirect can carry;
 *   - the IdP id, which must be one Zitadel currently offers rather than
 *     whatever the browser asked for;
 *   - the MFA decision, which runs on a federated session exactly as it does
 *     on a password one. `finalize` still demands the `Sufficient` proof.
 */

const client = vi.hoisted(() => ({
  listLoginPolicyIdps: vi.fn(),
  startIdpIntent: vi.fn(),
  retrieveIdpIntent: vi.fn(),
  createIdpSession: vi.fn(),
  getLoginPolicy: vi.fn(),
  getEnrolledFactors: vi.fn(),
  finalize: vi.fn(),
  loginClientConfig: vi.fn(),
}));

vi.mock("@/lib/auth/zitadel-login-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/zitadel-login-client")>();
  return { ...actual, ...client };
});

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const { GET: start } = await import("./idp/start/route");
const { GET: callback } = await import("./idp/callback/route");

const ORIGIN = "https://console.tesserix.app";
const TOTP = "AUTHENTICATION_METHOD_TYPE_TOTP";

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), {
    headers: { host: "console.tesserix.app" },
  });
}

beforeEach(() => {
  jar.clear();
  vi.clearAllMocks();
  client.loginClientConfig.mockReturnValue({ issuer: "https://auth.test", token: "pat" });
  client.listLoginPolicyIdps.mockResolvedValue([{ id: "idp-1", name: "Google" }]);
  client.startIdpIntent.mockResolvedValue("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  client.retrieveIdpIntent.mockResolvedValue({ userId: "u1", verified: {} });
  client.createIdpSession.mockResolvedValue({ id: "s9", token: "t9" });
  client.getLoginPolicy.mockResolvedValue({ forceMfa: false, forceMfaLocalOnly: false });
  client.getEnrolledFactors.mockResolvedValue({ secondFactorTypes: [], passkeyCount: 0 });
  client.finalize.mockResolvedValue(`${ORIGIN}/auth/callback?code=abc`);
});

describe("starting a federated login", () => {
  it("sends the browser to the provider and remembers the auth request in a cookie", async () => {
    const response = await start(request("/login/idp/start?authRequest=V2_1&idp=idp-1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    );
    // Not carried in the redirect URL: the provider round trip is the one
    // place the auth request would be visible to something outside the
    // console, and the callback must not take its word for which login it is
    // finishing.
    expect(jar.get("tx_login_idp")).toContain("V2_1");
    expect(client.startIdpIntent).toHaveBeenCalledWith(expect.anything(), "idp-1", {
      successUrl: `${ORIGIN}/login/idp/callback`,
      failureUrl: `${ORIGIN}/login?authRequest=V2_1&error=idp`,
    });
  });

  it("refuses an IdP id the login policy does not currently offer", async () => {
    // The id arrives from the browser. Checked against what Zitadel says it
    // offers right now, so a crafted link cannot make the console start an
    // intent for a provider the org never bound.
    const response = await start(request("/login/idp/start?authRequest=V2_1&idp=idp-evil"));

    expect(client.startIdpIntent).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?authRequest=V2_1&error=idp`);
  });

  it("goes back to the login page when there is no auth request to finish", async () => {
    const response = await start(request("/login/idp/start?idp=idp-1"));
    expect(client.startIdpIntent).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });
});

describe("finishing a federated login", () => {
  async function begin() {
    await start(request("/login/idp/start?authRequest=V2_1&idp=idp-1"));
  }

  it("completes the login for an operator with nothing else to prove", async () => {
    await begin();
    const response = await callback(request("/login/idp/callback?id=intent-1&token=it-1"));

    expect(client.createIdpSession).toHaveBeenCalledWith(expect.anything(), {
      id: "intent-1",
      token: "it-1",
    });
    expect(client.finalize).toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/callback?code=abc`);
    // The round-trip cookie is spent.
    expect(jar.has("tx_login_idp")).toBe(false);
  });

  it("runs the MFA decision, and does NOT finalize when a factor is still owed", async () => {
    // The rule the issue insists on: arriving through Google is not by itself
    // sufficient. This operator enrolled an authenticator, so it is asked for
    // — in-page, on the console's own code step.
    client.getEnrolledFactors.mockResolvedValue({ secondFactorTypes: [TOTP], passkeyCount: 0 });
    await begin();

    const response = await callback(request("/login/idp/callback?id=intent-1&token=it-1"));

    expect(client.finalize).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?authRequest=V2_1&step=totp`);
    // The session the intent produced is parked for the code step, exactly as
    // the password path parks the one the password produced.
    expect(jar.get("tx_login_pending")).toContain("s9");
  });

  it("takes the forceMfaLocalOnly exemption a federated login is entitled to", async () => {
    client.getLoginPolicy.mockResolvedValue({ forceMfa: false, forceMfaLocalOnly: true });
    await begin();

    const response = await callback(request("/login/idp/callback?id=intent-1&token=it-1"));

    expect(client.finalize).toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/callback?code=abc`);
  });

  it("still hands off a federated login under an unconditional forceMfa", async () => {
    client.getLoginPolicy.mockResolvedValue({ forceMfa: true, forceMfaLocalOnly: false });
    await begin();

    const response = await callback(request("/login/idp/callback?id=intent-1&token=it-1"));

    expect(client.finalize).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain("/ui/v2/login/login?authRequest=V2_1");
  });

  it("refuses a callback with no cookie from a start it performed", async () => {
    // Nothing in the query string says which login this is. Without the
    // cookie the console would be finishing an auth request chosen by whoever
    // built the URL.
    const response = await callback(request("/login/idp/callback?id=intent-1&token=it-1"));

    expect(client.retrieveIdpIntent).not.toHaveBeenCalled();
    expect(client.finalize).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=restart`);
  });

  it("says nothing about whether a Google account belongs to an operator", async () => {
    // An unlinked external identity gets the same answer as a bad password.
    const { LoginClientError } = await import("@/lib/auth/zitadel-login-client");
    client.retrieveIdpIntent.mockRejectedValue(new LoginClientError("unknown-user", "not linked"));
    await begin();

    const response = await callback(request("/login/idp/callback?id=intent-1&token=it-1"));

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?authRequest=V2_1&error=idp`);
  });
});
