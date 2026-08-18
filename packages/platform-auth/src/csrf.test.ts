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

  it("allows console.tesserix.app writes with no CSRF_ALLOWED_DOMAINS set", () => {
    // The console deployment sets no CSRF_ALLOWED_DOMAINS; the code default is
    // what keeps it working (and what keeps it from failing open).
    expect(
      evaluateCsrf(
        req({
          headers: {
            host: "console.tesserix.app",
            origin: "https://console.tesserix.app",
            cookie: "tx_session=xyz",
          },
        }),
      ).blocked,
    ).toBe(false);
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
    const d = evaluateCsrf(
      req({ headers: { host: "tesserix.app", origin: "https://tesserix.app", cookie: "tx_session=xyz" } }),
      new Set<string>(),
    );
    expect(d.blocked).toBe(true);
  });
});
