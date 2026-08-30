import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LoginClientError,
  addTotpCheck,
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
    expect(checkSufficiency({ forceMfa: false, forceMfaLocalOnly: false }, factors, null).proof).toBeNull();
  });

  it("treats a session with no resolvable user as unknown", async () => {
    respond({ session: {} });
    const factors = await getEnrolledFactors(config, { id: "s1", token: "t1" });
    expect(checkSufficiency({ forceMfa: false, forceMfaLocalOnly: false }, factors, null).proof).toBeNull();
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
      null,
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
      null,
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

describe("addTotpCheck", () => {
  it("adds the code to the EXISTING session rather than making a new one", async () => {
    // A second session would be a second password check the operator never
    // made, and would strand the one the auth request is about to be handed.
    let seen: { url: string; method: string; body: unknown } = { url: "", method: "", body: null };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen = { url, method: String(init.method), body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ sessionToken: "t2" }), { status: 200 });
    });

    await addTotpCheck(config, { id: "s1", token: "t1" }, "123456");

    expect(seen.method).toBe("PATCH");
    expect(seen.url).toBe("https://auth.test/v2/sessions/s1");
    expect(seen.body).toEqual({ sessionToken: "t1", checks: { totp: { code: "123456" } } });
  });

  it("maps a rejected code to bad-credentials, whichever 4xx Zitadel picks", async () => {
    // Zitadel answers an invalid TOTP with 400 InvalidArgument, not 401. Left
    // to the generic mapping that reads as "upstream", i.e. "sign-in is
    // temporarily unavailable" — which sends the operator to wait out an
    // outage that is really a mistyped digit.
    for (const status of [400, 401, 403]) {
      respond({ message: "Errors.User.MFA.OTP.InvalidCode" }, status);
      await expect(addTotpCheck(config, { id: "s1", token: "t1" }, "000000")).rejects.toMatchObject({
        kind: "bad-credentials",
      });
    }
  });

  it("keeps a real outage distinguishable from a wrong code", async () => {
    respond("boom", 500);
    await expect(addTotpCheck(config, { id: "s1", token: "t1" }, "123456")).rejects.toMatchObject({
      kind: "upstream",
    });
  });
});

describe("the sufficiency proof after a second factor", () => {
  it("cannot be obtained without a successful TOTP check", async () => {
    // The guarantee, restated for the factor path: a failed check yields no
    // TotpVerified, and without one the decision withholds the proof, so
    // `finalize` does not compile at that call site.
    respond({ message: "Errors.User.MFA.OTP.InvalidCode" }, 400);
    await expect(addTotpCheck(config, { id: "s1", token: "t1" }, "000000")).rejects.toThrow(
      LoginClientError,
    );

    expect(
      checkSufficiency(
        { forceMfa: true, forceMfaLocalOnly: false },
        { secondFactorTypes: ["AUTHENTICATION_METHOD_TYPE_TOTP"], passkeyCount: 0 },
        null,
      ).proof,
    ).toBeNull();
  });

  it("is granted once the check has succeeded", async () => {
    respond({ sessionToken: "t2" });
    const verified = await addTotpCheck(config, { id: "s1", token: "t1" }, "123456");

    const { sufficiency, proof } = checkSufficiency(
      { forceMfa: true, forceMfaLocalOnly: false },
      { secondFactorTypes: ["AUTHENTICATION_METHOD_TYPE_TOTP"], passkeyCount: 0 },
      verified,
    );

    expect(sufficiency).toEqual({ outcome: "complete" });
    expect(proof).not.toBeNull();
  });

  it("does not accept a hand-rolled stand-in for a verified check", () => {
    // @ts-expect-error TotpVerified is branded; only addTotpCheck returns one
    void (() => checkSufficiency({ forceMfa: false, forceMfaLocalOnly: false }, { secondFactorTypes: [], passkeyCount: 0 }, {}));
  });
});

/**
 * Stub fetch per URL, because `getEnrolledFactors` makes TWO calls — the
 * session, then that user's methods — and a single canned body cannot tell
 * the story of either one.
 */
function route(handler: (url: string) => unknown | { status: number; body: unknown }) {
  vi.stubGlobal("fetch", async (url: string) => {
    const answer = handler(String(url)) as { status?: number; body?: unknown };
    const isEnvelope =
      answer !== null && typeof answer === "object" && "status" in answer && "body" in answer;
    const status = isEnvelope ? Number(answer.status) : 200;
    const body = isEnvelope ? answer.body : answer;
    return new Response(JSON.stringify(body), { status });
  });
}

const SESSION_USER = {
  session: { id: "s1", factors: { user: { id: "u1", loginName: "operator@tesserix.test" } } },
};

describe("getEnrolledFactors", () => {
  it("completes a login for a user with NO enrolled methods", async () => {
    // The exact case that was broken in production. Zitadel omits
    // `authMethodTypes` entirely rather than sending an empty array, and the
    // session resolves to a real user id, so this is "we looked and there is
    // nothing to ask for" — not "we could not find out".
    route((url) => (url.includes("/v2/sessions/") ? SESSION_USER : {}));

    const factors = await getEnrolledFactors(config, { id: "s1", token: "t1" });

    expect(factors).toEqual({ secondFactorTypes: [], passkeyCount: 0 });
    expect(
      checkSufficiency({ forceMfa: false, forceMfaLocalOnly: false }, factors, null).proof,
    ).not.toBeNull();
  });

  it("completes a login for an operator whose only extra method is a federated IdP link", async () => {
    // `["...PASSWORD", "...IDP"]` is verbatim what the live instance returns
    // for the console's operators. Counting IDP as a second factor is what
    // sent every one of them to Zitadel's hosted login after typing a correct
    // password on the console's own page.
    route((url) =>
      url.includes("/v2/sessions/")
        ? SESSION_USER
        : {
            authMethodTypes: [
              "AUTHENTICATION_METHOD_TYPE_PASSWORD",
              "AUTHENTICATION_METHOD_TYPE_IDP",
            ],
          },
    );

    const factors = await getEnrolledFactors(config, { id: "s1", token: "t1" });

    expect(factors).toEqual({ secondFactorTypes: [], passkeyCount: 0 });
    expect(
      checkSufficiency({ forceMfa: false, forceMfaLocalOnly: false }, factors, null).proof,
    ).not.toBeNull();
  });

  it("still refuses to complete for a user holding a real second factor", async () => {
    // The other live operator has a security key. Nothing about the IdP fix
    // may reach this one: U2F is not collectible in-page, so it hands off.
    route((url) =>
      url.includes("/v2/sessions/")
        ? SESSION_USER
        : {
            authMethodTypes: [
              "AUTHENTICATION_METHOD_TYPE_PASSWORD",
              "AUTHENTICATION_METHOD_TYPE_IDP",
              "AUTHENTICATION_METHOD_TYPE_U2F",
            ],
          },
    );

    const factors = await getEnrolledFactors(config, { id: "s1", token: "t1" });

    expect(factors.secondFactorTypes).toEqual(["AUTHENTICATION_METHOD_TYPE_U2F"]);
    expect(
      checkSufficiency({ forceMfa: false, forceMfaLocalOnly: false }, factors, null).sufficiency,
    ).toEqual({ outcome: "handoff", reason: "user-has-second-factor" });
  });

  it("reads the session with the login-client token alone", async () => {
    // VERIFIED against the live instance (Zitadel v4.15.3): a plain
    // `GET /v2/sessions/{id}` carrying only the login-client bearer answers
    // 200 WITH `factors.user.id`. The session token is not required to see the
    // factors, so its absence was never the reason this returned "unknown".
    let seen = "";
    route((url) => {
      if (url.includes("/v2/sessions/")) {
        seen = url;
        return SESSION_USER;
      }
      return {};
    });

    await getEnrolledFactors(config, { id: "s1", token: "session-token" });

    expect(seen).toBe("https://auth.test/v2/sessions/s1");
    expect(seen).not.toContain("session-token");
  });

  it("says so in the log when a permanent hand-off is caused by a failed lookup", async () => {
    // The two inputs to this decision used to fail into a bare `catch {}`.
    // Failing closed is right; failing closed SILENTLY is what made a
    // hand-off-for-everyone take a screenshot to find.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respond("boom", 500);

    await getEnrolledFactors(config, { id: "s1", token: "t1" });
    await getLoginPolicy(config);

    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain("[login] could not read the enrolled factors; handing off");
    expect(messages).toContain("[login] could not read the login policy; assuming MFA is forced");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("login-client-pat");
    warn.mockRestore();
  });

  it("logs the session that resolved to no user rather than swallowing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respond({ session: {} });

    await getEnrolledFactors(config, { id: "s1", token: "t1" });

    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      "[login] session resolved to no user; handing off",
    );
    warn.mockRestore();
  });
});
