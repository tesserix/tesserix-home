import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));

const { deleteTokensMock } = vi.hoisted(() => ({ deleteTokensMock: vi.fn() }));
vi.mock("@/lib/auth/operator-token-store", () => ({
  deleteTokens: deleteTokensMock,
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { GET, POST } from "./route";

function request(): NextRequest {
  return new NextRequest("https://console.tesserix.app/auth/logout", {
    headers: { "x-forwarded-host": "console.tesserix.app", "x-forwarded-proto": "https" },
  });
}

function signIn(roles: readonly string[] | undefined, sid?: string) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "op@tesserix.app",
    roles,
    sid,
    iat: 0,
    exp: 0,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteTokensMock.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.stubEnv("SESSION_COOKIE_DOMAIN", ".tesserix.app");
  vi.stubEnv("ZITADEL_ISSUER", "https://auth.tesserix.app");
  vi.stubEnv("ZITADEL_CLIENT_ID", "386382971877196703");
  vi.stubEnv("ZITADEL_POST_LOGOUT_REDIRECT_URI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /auth/logout", () => {
  it("expires the shared session cookie on the parent domain", async () => {
    signIn(["read"]);
    const res = await GET(request());
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("tx_session=");
    expect(cookie.toLowerCase()).toContain("max-age=0");
    expect(cookie).toContain("Domain=.tesserix.app");
    expect(cookie).toContain("HttpOnly");
  });

  it("redirects to the console's own login when no IdP logout is configured", async () => {
    signIn(["read"]);
    const res = await GET(request());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://console.tesserix.app/auth/login",
    );
  });

  it("ends the Zitadel session when a post-logout redirect is configured", async () => {
    // Only when configured: Zitadel rejects a post_logout_redirect_uri that is
    // not registered against the application, and registering it is a change
    // this repo cannot make.
    signIn(["read"]);
    vi.stubEnv(
      "ZITADEL_POST_LOGOUT_REDIRECT_URI",
      "https://console.tesserix.app/auth/login",
    );
    const res = await GET(request());
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://auth.tesserix.app/oidc/v1/end_session");
    expect(location).toContain(
      "post_logout_redirect_uri=https%3A%2F%2Fconsole.tesserix.app%2Fauth%2Flogin",
    );
    expect(location).toContain("client_id=386382971877196703");
  });

  it("still expires the cookie when redirecting to the IdP", async () => {
    // The local session must end even if Zitadel refuses the request.
    signIn(["read"]);
    vi.stubEnv(
      "ZITADEL_POST_LOGOUT_REDIRECT_URI",
      "https://console.tesserix.app/auth/login",
    );
    const res = await GET(request());
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain(
      "max-age=0",
    );
  });

  it("refuses a session without the read capability", async () => {
    signIn([]);
    const res = await GET(request());
    expect(res.status).toBe(403);
  });

  it("refuses a null session", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(403);
  });
});

describe("POST /auth/logout", () => {
  it("behaves the same as GET", async () => {
    signIn(["read"]);
    const res = await POST(request());
    expect(res.status).toBe(307);
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain(
      "max-age=0",
    );
  });
});

describe("revoking platform API access on sign-out", () => {
  it("deletes the operator token row for the session's sid", async () => {
    signIn(["read"], "sid-123");

    const res = await GET(request());

    expect(res.status).toBe(307);
    expect(deleteTokensMock).toHaveBeenCalledTimes(1);
    expect(deleteTokensMock).toHaveBeenCalledWith("sid-123");
  });

  it("succeeds when the session carries no sid", async () => {
    // Minted before the store shipped, or minted by apps/web, which shares
    // the tx_session cookie. Neither is an error — there is simply no row.
    signIn(["read"], undefined);

    const res = await GET(request());

    expect(res.status).toBe(307);
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain(
      "max-age=0",
    );
    expect(deleteTokensMock).not.toHaveBeenCalled();
  });

  it("still signs the operator out locally when the delete fails", async () => {
    signIn(["read"], "sid-456");
    deleteTokensMock.mockRejectedValue(new Error("store unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(request());

    expect(res.status).toBe(307);
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain(
      "max-age=0",
    );
    expect(error).toHaveBeenCalledWith(
      "[auth/logout] failed to delete operator API tokens",
      expect.objectContaining({ sid: "sid-456" }),
    );
  });

  it(
    "still signs the operator out locally when the delete HANGS",
    async () => {
      // The failure mode this branch introduced: before the token store,
      // logout did no I/O and could not hang. The cookie is expired on the
      // RESPONSE, so a response that never returns leaves `tx_session` intact
      // and the operator authenticated across `.tesserix.app` — on the surface
      // whose whole purpose is ending that session. The rejected-promise test
      // above does not cover it: nothing throws here, the DELETE simply never
      // comes back. `DELETE_TOKENS_DEADLINE_MS` (2000ms in route.ts), not the
      // store, has to end the wait.
      //
      // Real timers, deliberately: `withDeadline`'s `setTimeout` and this
      // test's wall clock must be the same clock for "the deadline fired" to
      // be a fact about the code rather than an artifact of fake-time
      // advancement.
      signIn(["read"], "sid-789");
      deleteTokensMock.mockReturnValue(new Promise(() => {}));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await GET(request());

      // The observable outcome, not "nothing threw": redirected, and signed
      // out. A broken implementation never reaches these lines at all.
      expect(res.status).toBe(307);
      expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain(
        "max-age=0",
      );
      expect(res.headers.get("set-cookie")).toContain("tx_session=");
      expect(error).toHaveBeenCalledWith(
        "[auth/logout] failed to delete operator API tokens",
        expect.objectContaining({ sid: "sid-789" }),
      );
    },
    { timeout: 6_000 },
  );
});
