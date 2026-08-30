import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginClientError } from "@/lib/auth/zitadel-login-client";

/**
 * The second-factor path of the console's own login.
 *
 * Everything here is about one failure mode: a login that finishes without the
 * factor the organization asked for. Zitadel will not catch it — it issues an
 * authorization code for a password-only session even under `forceMfa` when
 * the caller is a login client — so the tests stand in for the enforcement
 * that the identity provider is not doing.
 *
 * The sufficiency decision itself is NOT mocked. Mocking it would leave the
 * one function whose failure is silent untested through the path that calls it.
 */

const client = vi.hoisted(() => ({
  getAuthRequest: vi.fn(),
  createPasswordSession: vi.fn(),
  getLoginPolicy: vi.fn(),
  getEnrolledFactors: vi.fn(),
  addTotpCheck: vi.fn(),
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

const { submitCredentials, submitTotp } = await import("./actions");

const TOTP = "AUTHENTICATION_METHOD_TYPE_TOTP";
const session = { id: "s1", token: "t1" };

beforeEach(() => {
  jar.clear();
  vi.clearAllMocks();
  client.loginClientConfig.mockReturnValue({ issuer: "https://auth.test", token: "pat" });
  client.getAuthRequest.mockResolvedValue({ id: "req-1", clientId: "console-web" });
  client.createPasswordSession.mockResolvedValue(session);
  client.getLoginPolicy.mockResolvedValue({ forceMfa: true, forceMfaLocalOnly: false });
  client.getEnrolledFactors.mockResolvedValue({ secondFactorTypes: [TOTP], passkeyCount: 0 });
  client.addTotpCheck.mockResolvedValue({});
  client.finalize.mockResolvedValue("https://console.tesserix.app/auth/callback?code=abc");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function pastThePassword() {
  return submitCredentials({ authRequestId: "req-1", loginName: "op@tesserix.test", password: "pw" });
}

describe("submitCredentials", () => {
  it("asks for a code in-page when the account has an authenticator", async () => {
    // This is the case that could not sign in at all: the hand-off pointed at
    // Zitadel's V1 login UI, which cannot resolve a V2 auth request.
    await expect(pastThePassword()).resolves.toEqual({ outcome: "second-factor", factor: "totp" });
    expect(client.finalize).not.toHaveBeenCalled();
  });

  it("does not complete the login while the factor is still outstanding", async () => {
    await pastThePassword();
    expect(client.finalize).not.toHaveBeenCalled();
  });

  it("still completes an account with nothing to ask for", async () => {
    client.getLoginPolicy.mockResolvedValue({ forceMfa: false, forceMfaLocalOnly: false });
    client.getEnrolledFactors.mockResolvedValue({ secondFactorTypes: [], passkeyCount: 0 });

    await expect(pastThePassword()).resolves.toMatchObject({ outcome: "complete" });
  });
});

describe("submitTotp", () => {
  it("completes the login when the code checks out", async () => {
    await pastThePassword();

    await expect(submitTotp({ authRequestId: "req-1", code: "123456" })).resolves.toEqual({
      outcome: "complete",
      callbackUrl: "https://console.tesserix.app/auth/callback?code=abc",
    });
    expect(client.addTotpCheck).toHaveBeenCalledWith(expect.anything(), session, "123456");
  });

  it("does NOT complete the login when the code is rejected", async () => {
    // The whole reason the factor is collected at all. A wrong code must leave
    // the operator exactly where they were, not fall through to a callback.
    await pastThePassword();
    client.addTotpCheck.mockRejectedValue(
      new LoginClientError("bad-credentials", "Errors.User.MFA.OTP.InvalidCode"),
    );

    const result = await submitTotp({ authRequestId: "req-1", code: "000000" });

    expect(result.outcome).toBe("failed");
    expect(client.finalize).not.toHaveBeenCalled();
  });

  it("offers a retry rather than a dead end after a rejected code", async () => {
    // "A half-built factor prompt is worse than none": the operator must be
    // able to type the next code without starting the whole login again.
    await pastThePassword();
    client.addTotpCheck.mockRejectedValueOnce(
      new LoginClientError("bad-credentials", "Errors.User.MFA.OTP.InvalidCode"),
    );

    await submitTotp({ authRequestId: "req-1", code: "000000" });

    await expect(submitTotp({ authRequestId: "req-1", code: "123456" })).resolves.toMatchObject({
      outcome: "complete",
    });
  });

  it("does not reveal whether the account exists or has TOTP enrolled", async () => {
    // The instance runs `ignoreUnknownUsernames`. A message that named the
    // enrolment state would undo it for anyone willing to guess a username.
    await pastThePassword();
    client.addTotpCheck.mockRejectedValue(
      new LoginClientError("bad-credentials", "Errors.User.MFA.OTP.InvalidCode"),
    );

    const result = await submitTotp({ authRequestId: "req-1", code: "000000" });

    expect(result.outcome).toBe("failed");
    const message = "message" in result ? result.message : "";
    expect(message).not.toMatch(/enroll|enrol|not found|unknown|exist|TOTP is not/i);
  });

  it("rejects a code for an auth request it did not collect the password for", async () => {
    // The pending session is bound to its auth request, so a stale cookie
    // cannot be replayed into a different login.
    await pastThePassword();

    await expect(submitTotp({ authRequestId: "req-2", code: "123456" })).resolves.toMatchObject({
      outcome: "restart",
    });
    expect(client.addTotpCheck).not.toHaveBeenCalled();
  });

  it("asks the operator to start again when there is no pending session", async () => {
    await expect(submitTotp({ authRequestId: "req-1", code: "123456" })).resolves.toMatchObject({
      outcome: "restart",
    });
    expect(client.addTotpCheck).not.toHaveBeenCalled();
  });

  it("does not complete when the re-derived decision still withholds the proof", async () => {
    // Defence in depth: the completion is whatever the decision says, never a
    // consequence of having called `addTotpCheck`.
    await pastThePassword();
    client.getEnrolledFactors.mockResolvedValue({ secondFactorTypes: ["unknown"], passkeyCount: 0 });
    client.addTotpCheck.mockRejectedValue(
      new LoginClientError("bad-credentials", "Errors.User.MFA.OTP.InvalidCode"),
    );

    const result = await submitTotp({ authRequestId: "req-1", code: "000000" });

    expect(result.outcome).not.toBe("complete");
    expect(client.finalize).not.toHaveBeenCalled();
  });

  it("clears the pending session once the login has completed", async () => {
    // It carries a Zitadel session token that can finish a login on its own.
    await pastThePassword();
    await submitTotp({ authRequestId: "req-1", code: "123456" });

    await expect(submitTotp({ authRequestId: "req-1", code: "123456" })).resolves.toMatchObject({
      outcome: "restart",
    });
  });
});
