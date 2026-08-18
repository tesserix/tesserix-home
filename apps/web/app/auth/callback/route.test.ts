import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "./route";

/**
 * `publicOrigin` here is module-private, but it is reachable without touching
 * the route's shape: Google redirects back with `?error=access_denied` when a
 * user cancels consent, and that path builds its /login redirect from
 * `publicOrigin` and returns before any token exchange, cookie check or
 * network call. So the seam under test is the real one — the redirect a
 * browser actually receives — rather than an export added for the test.
 */
function cancelledLogin(headers: Record<string, string>): Promise<Response> {
  return GET(
    new NextRequest("https://0.0.0.0:3000/auth/callback?error=access_denied", {
      headers,
    }),
  );
}

async function redirectOrigin(headers: Record<string, string>): Promise<string> {
  const location = (await cancelledLogin(headers)).headers.get("location");
  return new URL(location ?? "").origin;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /auth/callback redirect origin", () => {
  it("uses the forwarded host rather than the pod's bind address", () => {
    // The request URL above is the pod's 0.0.0.0 bind address on purpose: that
    // is the condition this helper exists to correct.
    return expect(
      redirectOrigin({ "x-forwarded-host": "tesserix.app" }),
    ).resolves.toBe("https://tesserix.app");
  });

  it("ignores a forged forwarded host and falls back to this site's origin", async () => {
    // Issue #184: the ingress passes the client's X-Forwarded-Host through, so
    // this header used to come straight back as the redirect target.
    await expect(
      redirectOrigin({ "x-forwarded-host": "evil.example.com" }),
    ).resolves.toBe("https://tesserix.app");
  });

  it("rejects a forged host hiding in front of a real one in a proxy chain", async () => {
    await expect(
      redirectOrigin({ "x-forwarded-host": "evil.example.com, tesserix.app" }),
    ).resolves.toBe("https://tesserix.app");
  });

  it("does not let a forged proto downgrade the redirect to http", async () => {
    await expect(
      redirectOrigin({
        "x-forwarded-host": "tesserix.app",
        "x-forwarded-proto": "http",
      }),
    ).resolves.toBe("https://tesserix.app");
  });

  it("rejects a host that merely extends the allowed one", async () => {
    await expect(
      redirectOrigin({ "x-forwarded-host": "tesserix.app.evil.com" }),
    ).resolves.toBe("https://tesserix.app");
    await expect(
      redirectOrigin({ "x-forwarded-host": "console.tesserix.app" }),
    ).resolves.toBe("https://tesserix.app");
  });

  it("tracks SITE_ORIGIN rather than hard-coding the production host", async () => {
    // Guards the guard: with a literal allowlist every assertion above would
    // still pass while the check read nothing. Move the site origin and both
    // the accept and the reject verdict must move with it.
    vi.stubEnv("SITE_ORIGIN", "https://staging.example.test");

    await expect(
      redirectOrigin({ "x-forwarded-host": "staging.example.test" }),
    ).resolves.toBe("https://staging.example.test");
    await expect(
      redirectOrigin({ "x-forwarded-host": "tesserix.app" }),
    ).resolves.toBe("https://staging.example.test");
  });

  it("keeps loopback working outside production", async () => {
    await expect(redirectOrigin({ host: "localhost:3002" })).resolves.toBe(
      "http://localhost:3002",
    );
  });

  it("rejects loopback in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      redirectOrigin({ "x-forwarded-host": "localhost:3002" }),
    ).resolves.toBe("https://tesserix.app");
  });

  it("falls back to the default when SITE_ORIGIN is not a URL", async () => {
    // A config typo must not take login down, so an unparseable value is
    // treated as unconfigured. (The old loopback special case is gone with the
    // build-time inline that made it necessary — a SITE_ORIGIN set at runtime
    // is a deliberate choice and is honoured.)
    vi.stubEnv("SITE_ORIGIN", "not a url");

    await expect(
      redirectOrigin({ "x-forwarded-host": "tesserix.app" }),
    ).resolves.toBe("https://tesserix.app");
  });

  it("preserves the OAuth error code on the redirect", async () => {
    // Guards the guard: proves these cases are exercising the real cancelled-
    // consent path and not some generic fallback that happens to redirect.
    const location = (await cancelledLogin({ "x-forwarded-host": "tesserix.app" }))
      .headers.get("location");

    expect(location).toBe("https://tesserix.app/login?error=access_denied");
  });
});
