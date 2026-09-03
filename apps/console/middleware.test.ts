import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  verifySession: vi.fn(),
}));

import { verifySession } from "@tesserix/platform-auth";
import { middleware } from "./middleware";
import { CONSOLE_PATHNAME_HEADER } from "./lib/auth/console-pathname";

/**
 * The `MACHINE_AUTH_PATHS` exemption in `middleware.ts` — a deliberate hole
 * in the console's global session gate, opened for `/api/v1/plan-catalog` so
 * it can do its own Zitadel-machine-token auth instead. This suite is
 * scoped to that hole, not a general middleware suite: what bypasses the
 * session check, what does not, and that CSRF is still evaluated first.
 *
 * `evaluateCsrf` and `bearerToken`/`sessionCookieName` are left REAL (only
 * `verifySession` is mocked) — the CSRF property below depends on the actual
 * origin-checking logic actually running, not a stub that always says
 * "not blocked".
 */

function req(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(url, init);
}

const BASE = "https://console.tesserix.app";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifySession).mockResolvedValue(null);
});

describe("both allowlisted forms bypass the session check", () => {
  it("lets an unauthenticated request through to the route for the bare path", async () => {
    const res = await middleware(req(`${BASE}/api/v1/plan-catalog?mode=test`));

    // NextResponse.next() carries no synthetic status of its own (200 is the
    // default for a pass-through) and, crucially, never called verifySession.
    expect(verifySession).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("lets an unauthenticated request through for the trailing-slash form too", async () => {
    // Established empirically: `NextRequest`'s own `nextUrl.pathname` keeps a
    // trailing slash exactly as given (no `trailingSlash` config here, and
    // any fold-together redirect is applied by the router, which runs AFTER
    // middleware) — so a client that appends one must not fall through to
    // the session-cookie branch.
    const res = await middleware(req(`${BASE}/api/v1/plan-catalog/?mode=test`));

    expect(verifySession).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

describe("a path that merely starts with the prefix is NOT exempt", () => {
  it("still requires a session for a hypothetical sub-resource", async () => {
    const res = await middleware(req(`${BASE}/api/v1/plan-catalog/admin`));

    // No session cookie/bearer present, so this must fall through to the
    // session gate and be refused — proving the allowlist is exact-match,
    // not a subtree match reintroduced by the trailing-slash fix.
    expect(verifySession).not.toHaveBeenCalled(); // no token to verify at all
    expect(res.status).toBe(401);
  });

  it("still requires a session for the dot-segment smuggling shape", async () => {
    const res = await middleware(
      req(`${BASE}/api/v1/plan-catalog/..%2fadmin`),
    );

    expect(res.status).toBe(401);
  });
});

describe("a different API path still requires a session", () => {
  it("refuses an unauthenticated request to an unrelated route", async () => {
    const res = await middleware(req(`${BASE}/api/notifications`));

    expect(res.status).toBe(401);
  });
});

describe("CSRF is still evaluated before the exemption is consulted", () => {
  it("blocks a mutating request to the exempt path with a mismatched Origin", async () => {
    const res = await middleware(
      req(`${BASE}/api/v1/plan-catalog`, {
        method: "POST",
        headers: { origin: "https://evil.example.com" },
      }),
    );

    // CSRF's own check runs before `isMachineAuthPath` in `middleware()`, so
    // a mutating cross-origin request to the exempt path is refused by CSRF
    // — the exemption only ever widens who reaches the ROUTE's own auth, it
    // does not opt the path out of CSRF.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("CSRF");
  });

  it("does not block a same-origin GET to the exempt path", async () => {
    const res = await middleware(
      req(`${BASE}/api/v1/plan-catalog?mode=test`, { method: "GET" }),
    );

    // GET is never CSRF-mutating, so this reaches the exemption and passes.
    expect(res.status).toBe(200);
  });
});

/**
 * The pathname handed to the console's capability gate (#262).
 *
 * `middleware.ts` is the only place in the console that holds an un-decoded
 * path, so it is where percent-encoding has to be normalised away — see
 * `lib/auth/console-pathname.ts`. This asserts the wiring: that the header the
 * layout reads carries the NORMALISED path, not `nextUrl.pathname`. What that
 * normalisation must and must not do is `console-pathname.test.ts`.
 */
describe("the forwarded pathname header is normalised", () => {
  function forwardedPathname(res: Response): string | null {
    // `NextResponse.next({ request: { headers } })` does not mutate the
    // request object the test holds; it encodes the overrides onto the
    // RESPONSE as `x-middleware-request-<name>`, which the Next server then
    // replays onto the incoming request. That indirection is why this is read
    // off the response rather than off `req`.
    return res.headers.get(`x-middleware-request-${CONSOLE_PATHNAME_HEADER}`);
  }

  beforeEach(() => {
    vi.mocked(verifySession).mockResolvedValue({
      sub: "op-1",
      email: "ops@tesserix.app",
      roles: ["platform"],
    } as never);
  });

  function authed(path: string) {
    return req(`${BASE}${path}`, { headers: { authorization: "Bearer session-jwe" } });
  }

  it("forwards a plain path unchanged", async () => {
    const res = await middleware(authed("/mark8ly/tenants"));

    expect(forwardedPathname(res)).toBe("/mark8ly/tenants");
  });

  it("forwards the decoded path for an encoded one", async () => {
    // The bypass: `nextUrl.pathname` keeps `%6D`, `capabilityForPath` matches
    // route paths literally and so found nothing, and the request rendered on
    // the entry capability while `[product]` decoded the same segment to
    // `mark8ly`.
    const res = await middleware(authed("/%6Dark8ly/%74enants"));

    expect(forwardedPathname(res)).toBe("/mark8ly/tenants");
  });

  it("forwards a segment it cannot decode exactly as it arrived", async () => {
    const res = await middleware(authed("/%6Dark8ly/tenants%2Fx"));

    expect(forwardedPathname(res)).toBe("/mark8ly/tenants%2Fx");
  });
});
