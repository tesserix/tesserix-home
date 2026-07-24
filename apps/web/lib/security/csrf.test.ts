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
