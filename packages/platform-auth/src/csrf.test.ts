import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateCsrf } from "./csrf";

function req(opts: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}) {
  const h = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method: opts.method ?? "POST",
    nextUrl: { pathname: opts.path ?? "/api/admin/apps/homechef/gw/orders" },
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("evaluateCsrf", () => {
  it("allows non-mutating and non-api requests", () => {
    expect(evaluateCsrf(req({ method: "GET" })).blocked).toBe(false);
    expect(evaluateCsrf(req({ method: "POST", path: "/admin/dashboard" })).blocked).toBe(false);
  });

  it("BLOCKS a mutating api request with no Origin/Referer and no bearer", () => {
    const d = evaluateCsrf(req({ headers: { host: "home.tesserix.app" } }));
    expect(d.blocked).toBe(true);
    expect(d.message).toContain("Origin header required");
  });

  it("ALLOWS a mutating api request that carries a valid Bearer token (mobile)", () => {
    const d = evaluateCsrf(
      req({ headers: { host: "home.tesserix.app", authorization: "Bearer abc.def.ghi" } }),
    );
    expect(d.blocked).toBe(false);
  });

  it("BLOCKS a mutating api request with BOTH a session cookie and a Bearer token", () => {
    const d = evaluateCsrf(
      req({
        headers: {
          host: "home.tesserix.app",
          cookie: "tx_session=xyz",
          authorization: "Bearer abc",
        },
      }),
    );
    expect(d.blocked).toBe(true);
  });

  it("still allows /api/internal/ (existing exemption)", () => {
    expect(evaluateCsrf(req({ path: "/api/internal/tickets" })).blocked).toBe(false);
  });

  it("blocks a cross-origin mutation and allows a same-host one", () => {
    vi.stubEnv("CSRF_ALLOWED_DOMAINS", "home.tesserix.app");
    expect(
      evaluateCsrf(req({ headers: { host: "home.tesserix.app", origin: "https://evil.com" } })).blocked,
    ).toBe(true);
    expect(
      evaluateCsrf(req({ headers: { host: "home.tesserix.app", origin: "https://home.tesserix.app" } })).blocked,
    ).toBe(false);
  });
});

describe("evaluateCsrf allowlist sourcing", () => {
  // The vulnerability: the allowlist used to be built from the request's own
  // headers, so a request nominated the hostname its Origin was checked
  // against. Both of these pass trivially if either derived source comes back.
  it("BLOCKS an attacker host nominated via x-forwarded-host", () => {
    const d = evaluateCsrf(
      req({
        headers: {
          host: "tesserix.app",
          "x-forwarded-host": "evil.example.com",
          origin: "https://evil.example.com",
          cookie: "tx_session=xyz",
        },
      }),
    );
    expect(d.blocked).toBe(true);
  });

  it("BLOCKS an attacker host nominated via host", () => {
    const d = evaluateCsrf(
      req({
        headers: {
          host: "evil.example.com",
          origin: "https://evil.example.com",
          cookie: "tx_session=xyz",
        },
      }),
    );
    expect(d.blocked).toBe(true);
  });

  it("allows genuine same-origin writes from both deployed hosts", () => {
    // Literals, not a loop over DEFAULT_CSRF_HOSTNAMES: iterating the list
    // under test would still pass if a host were dropped from it.
    for (const hostname of ["tesserix.app", "console.tesserix.app"]) {
      expect(
        evaluateCsrf(
          req({ headers: { host: hostname, origin: `https://${hostname}`, cookie: "tx_session=xyz" } }),
        ).blocked,
      ).toBe(false);
    }
  });

  it("treats CSRF_ALLOWED_DOMAINS as additive, not a replacement", () => {
    vi.stubEnv("CSRF_ALLOWED_DOMAINS", "staging.tesserix.app");
    expect(
      evaluateCsrf(req({ headers: { origin: "https://staging.tesserix.app", cookie: "tx_session=xyz" } }))
        .blocked,
    ).toBe(false);
    // The defaults survive the override.
    expect(
      evaluateCsrf(req({ headers: { origin: "https://tesserix.app", cookie: "tx_session=xyz" } })).blocked,
    ).toBe(false);
    expect(
      evaluateCsrf(req({ headers: { origin: "https://evil.example.com", cookie: "tx_session=xyz" } }))
        .blocked,
    ).toBe(true);
  });

  it("fails CLOSED on an empty allowlist", () => {
    // Proves the branch exists and which way it decides — NOT that production
    // can reach it. With DEFAULT_CSRF_HOSTNAMES non-empty it cannot be reached,
    // which is why the empty Set has to be injected. The branch is a guard
    // against someone later emptying the defaults, not a live code path.
    const d = evaluateCsrf(
      req({ headers: { host: "tesserix.app", origin: "https://tesserix.app", cookie: "tx_session=xyz" } }),
      new Set<string>(),
    );
    expect(d.blocked).toBe(true);
  });
});

describe("evaluateCsrf local development origins", () => {
  function localWrite(origin: string) {
    return evaluateCsrf(req({ headers: { host: "localhost:3002", origin, cookie: "tx_session=xyz" } }));
  }

  it("allows loopback origins under NODE_ENV=development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(localWrite("http://localhost:3002").blocked).toBe(false);
    expect(localWrite("http://127.0.0.1:3100").blocked).toBe(false);
    expect(localWrite("http://[::1]:3002").blocked).toBe(false);
    // A dev allowlist is still an allowlist.
    expect(localWrite("https://evil.example.com").blocked).toBe(true);
  });

  it("does NOT seed loopback outside development", () => {
    // The seeding is `=== "development"`, not `!== "production"`, so an
    // environment that never set NODE_ENV gets production behaviour rather
    // than silently acquiring localhost. Production is asserted alongside it
    // rather than as its own case — no mutation separates the two.
    vi.stubEnv("NODE_ENV", undefined);
    expect(localWrite("http://localhost:3002").blocked).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(localWrite("http://localhost:3002").blocked).toBe(true);
  });
});
