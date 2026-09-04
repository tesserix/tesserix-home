import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlatformApiError,
  fetchDashboard,
  fetchKoraAiMetricsPage,
  fetchOnboardingFunnel,
  fetchOnboardingSessions,
  fetchPlatformSources,
  fetchProductEntities,
  fetchProductKpis,
  parseDashboard,
  fetchSupportAnalytics,
  fetchTicketDetail,
  fetchTickets,
  postTicketReply,
  patchTicketStatus,
  ticketsQuery,
} from "./platform-api";
// Named explicitly — see the helper's own doc comment (#421). Every fixture
// below that stands in for a paged platform-api response uses one of these
// rather than a bare object literal, so the shape it asserts is a deliberate
// choice, not a guess that happens to match the parser under test.
import {
  paginationCursorMeta,
  paginationInMeta,
  paginationInsideData,
} from "./test-support/pagination-envelope";

const VALID = {
  tenants: { total: 12, active: 9 },
  stores: { total: 4 },
  leads: {
    by_status: { new: 3, contacted: 2, qualified: 1, converted: 5, lost: 0 },
    total: 11,
  },
  apps: { active: 6 },
  generated_at: "2026-08-14T07:00:00.000Z",
};

/**
 * Every `fetch` stub in this file goes through here, and the reason is #544 /
 * #394.
 *
 * `vi.unstubAllGlobals()` below restores `globalThis`, but it does not isolate
 * tests. Nothing in this file can abort an in-flight `platformCall`, so a test
 * the runner abandons on timeout leaves a live continuation. When that
 * continuation resumes it reads `globalThis.fetch` — which by then is the
 * *next* test's stub — and pushes a stray URL into that test's `seen[]`, or
 * drains the single `Response` a `mockResolvedValue` stub hands to every
 * caller. The neighbour then fails on evidence that belongs to its predecessor.
 *
 * That is #394 verbatim: "composes the queue from two resources when it is set"
 * times out, and "does not narrow the summary when the listing is filtered"
 * then fails because `seen.find(u => u.includes("/v1/tickets?"))` returned the
 * unfiltered `/v1/tickets?limit=200` the timed-out test had queued.
 *
 * Two things are done about it here, and neither is a cure:
 *
 * 1. **Attribution of the caller.** Each test runs in its own
 *    `AsyncLocalStorage` scope, and an abandoned continuation keeps the scope it
 *    was created in even when it resumes inside a later test. So the stub can
 *    tell a stale caller from a legitimate one — which nothing else can, because
 *    the stale call reaches the *current* stub and is otherwise identical to a
 *    real one. A stale call is recorded and NOT forwarded, so it cannot corrupt
 *    the running test, and it is handed a promise that never settles: it belongs
 *    to a test that no longer exists, and rejecting it would only produce an
 *    unhandled rejection attributed to nobody.
 * 2. **An in-flight count.** A test that ends with requests still outstanding
 *    fails saying so. This is NOT what names the culprit in the known case and
 *    must not be read as co-equal with (1): measured against the #394 ordering
 *    it fires **zero** times, because that culprit is abandoned at
 *    `await import("./platform-api")` — *before* it issues its request — so
 *    there is nothing in flight to count. It encodes a different invariant (no
 *    test may end mid-request) and catches the abandoned-mid-flight shape only.
 *
 * This DIAGNOSES; it does not prevent the class. A leaked continuation that
 * resumes before the next test installs its stub still reaches the real
 * `fetch`, and a test can still be abandoned mid-flight. Prevention needs a
 * cancellation path — an `AbortSignal` threaded through `platformCall` that a
 * test can fire in teardown. #544 carries that.
 *
 * A poisoned `fetch` installed in `afterEach` was tried first and does NOT
 * work: the leaked call lands after the next test has installed its own stub,
 * so the poison is already gone. Measured — it was called zero times against a
 * reproduction of the real ordering.
 */
type TestScope = {
  name: string;
  inFlight: number;
  leaks: { from: string; url: string }[];
};

const testScope = new AsyncLocalStorage<TestScope>();
let scope: TestScope | null = null;

beforeEach((ctx) => {
  scope = { name: ctx.task.name, inFlight: 0, leaks: [] };
  // `enterWith`, not `run`: a hook cannot wrap the test body in a callback, but
  // it can set the store on the async context the body inherits. Verified — the
  // stub reads the calling test's scope, and a leaked call reads its own.
  testScope.enterWith(scope);
});

/**
 * Installs `impl` as `globalThis.fetch` behind the guard above. Returns `impl`
 * unchanged, so a caller holding the `vi.fn()` still asserts on its own
 * `mock.calls`.
 */
function installFetchStub<T extends (...args: never[]) => unknown>(impl: T): T {
  const owner = scope;
  if (!owner) {
    // Unreachable today — all 41 call sites are inside `it()` bodies or helpers
    // called from them, so `beforeEach` has always run. Guarded anyway because
    // it is the one path that would fail silently: with no scope to record a
    // leak against, every call would be withheld and the test would hang to a
    // bare timeout carrying no explanation at all.
    throw new Error(
      "installFetchStub called outside a test scope — move the call inside `it()`.",
    );
  }
  vi.stubGlobal("fetch", (...args: never[]) => {
    const caller = testScope.getStore();
    if (caller !== owner) {
      // The stale caller's own scope names it, which is the whole point: a
      // leaked call is otherwise indistinguishable from a legitimate one.
      owner.leaks.push({ from: caller?.name ?? "(no test scope)", url: String(args[0]) });
      return new Promise(() => {});
    }
    owner.inFlight += 1;
    // Note: this wraps the stub's own promise, so `globalThis.fetch` returns a
    // promise that is not the mock's own and settles one microtask later.
    // Nothing in this file depends on either, but it is a real change at the
    // call boundary.
    return Promise.resolve(impl(...args)).finally(() => {
      owner.inFlight -= 1;
    });
  });
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
  const finished = scope;
  scope = null;
  if (!finished) {
    return;
  }
  if (finished.leaks.length > 0) {
    const culprits = [...new Set(finished.leaks.map((l) => l.from))];
    throw new Error(
      `#544: ${finished.leaks.length} request(s) left behind by ${culprits.map((c) => `"${c}"`).join(", ")} ` +
        `reached "${finished.name}"'s fetch stub. They were withheld, so this test's ` +
        `assertions are uncorrupted — the fault is in the named test(s), not this one. ` +
        `URLs: ${finished.leaks.map((l) => l.url).join(", ")}`,
    );
  }
  if (finished.inFlight > 0) {
    throw new Error(
      `#544: "${finished.name}" ended with ${finished.inFlight} request(s) still in flight. ` +
        `They will resume inside a later test and corrupt it. If this test also timed out, ` +
        `that is the cause and this is the culprit.`,
    );
  }
});

describe("parseDashboard", () => {
  it("accepts the documented shape", () => {
    expect(parseDashboard(VALID)).toEqual(VALID);
  });

  it("rejects a response missing a section rather than coercing it", () => {
    // A silently-wrong dashboard is worse than a visibly broken one: if the
    // contract drifts, the operator must see an error, not zeroes.
    const { tenants: _omitted, ...withoutTenants } = VALID;
    expect(() => parseDashboard(withoutTenants)).toThrow(PlatformApiError);
  });

  it("rejects a non-numeric count", () => {
    expect(() =>
      parseDashboard({ ...VALID, stores: { total: "4" } }),
    ).toThrow(PlatformApiError);
  });
});

describe("fetchDashboard", () => {
  it("forwards the caller's session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID), { status: 200 }),
    );
    installFetchStub(fetchMock);

    await fetchDashboard("tx_session=abc123");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("cookie")).toBe("tx_session=abc123");
  });

  it("preserves a 501 so the surface can report instrumentation-unavailable", async () => {
    installFetchStub(
      vi.fn().mockResolvedValue(new Response("", { status: 501 })),
    );

    await expect(fetchDashboard("c=1")).rejects.toMatchObject({ status: 501 });
  });

  it("preserves a 500 as a plain error, distinct from 501", async () => {
    installFetchStub(
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );

    await expect(fetchDashboard("c=1")).rejects.toMatchObject({ status: 500 });
  });

  it("surfaces a transport failure as a PlatformApiError with no status", async () => {
    installFetchStub(vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const err = await fetchDashboard("c=1").catch((e) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect(err.status).toBeUndefined();
  });

  it("formats a non-Error rejection without an undefined message, keeping the cause", async () => {
    installFetchStub(vi.fn().mockRejectedValue("ECONNRESET"));

    const err = await fetchDashboard("c=1").catch((e) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect(err.message).toBe("dashboard: request failed (ECONNRESET)");
    expect(err.message).not.toContain("undefined");
    expect(err.cause).toBe("ECONNRESET");
  });

  it("surfaces a 200 carrying a non-JSON body as a PlatformApiError", async () => {
    // A proxy or ingress error page arrives as HTML with a 200; the typed
    // boundary must hold rather than leaking a raw SyntaxError.
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response("<html>502 Bad Gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const err = await fetchDashboard("c=1").catch((e) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect(err.message).toContain("not JSON");
  });
});

const TICKET_ID = "5f0b2c34-0000-0000-0000-000000000000";

describe("postTicketReply", () => {
  it("sends the console origin so apps/web's CSRF gate accepts the write", async () => {
    // evaluateCsrf rejects cookie-bearing mutations with no Origin — which a
    // server-to-server call never has unless we set one deliberately.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reply: {} }), { status: 201 }),
    );
    installFetchStub(fetchMock);

    await postTicketReply(TICKET_ID, { content: "On it." }, "tx_session=abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/admin/platform-tickets/${TICKET_ID}/replies`);
    expect(init.method).toBe("POST");
    expect(init.headers.origin).toBe("https://console.tesserix.app");
    expect(init.headers.cookie).toBe("tx_session=abc");
    expect(JSON.parse(init.body)).toEqual({ content: "On it." });
  });

  it("throws a PlatformApiError carrying the status on failure", async () => {
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      ),
    );
    await expect(
      postTicketReply(TICKET_ID, { content: "x" }, ""),
    ).rejects.toMatchObject({ name: "PlatformApiError", status: 403 });
  });
});

describe("patchTicketStatus", () => {
  it("PATCHes the status with origin and cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ticket: {} }), { status: 200 }),
    );
    installFetchStub(fetchMock);

    await patchTicketStatus(TICKET_ID, "resolved", "tx_session=abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/admin/platform-tickets/${TICKET_ID}`);
    expect(init.method).toBe("PATCH");
    expect(init.headers.origin).toBe("https://console.tesserix.app");
    expect(JSON.parse(init.body)).toEqual({ status: "resolved" });
  });
});

const EMPTY_PAGE = {
  summary: { open: 0, inProgress: 0, resolvedThisWeek: 0, urgentOpen: 0 },
  rows: [],
};

describe("fetchTickets", () => {
  function stubTickets() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(EMPTY_PAGE), { status: 200 }),
    );
    installFetchStub(fetchMock);
    return fetchMock;
  }

  it("sends the filters upstream as query params", async () => {
    // Filtering is done in SQL by apps/web. The params have been accepted
    // since the endpoint shipped and no caller had ever sent them.
    const fetchMock = stubTickets();

    await fetchTickets("tx_session=abc", {
      status: "open",
      priority: "urgent",
      product: "mark8ly",
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/admin/platform-tickets");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("priority")).toBe("urgent");
    expect(url.searchParams.get("product")).toBe("mark8ly");
  });

  it("sends no query string at all when nothing is filtered", async () => {
    // Guards the guard: a request that always carried the params — or one that
    // dropped them — would still satisfy a test that only checked the path.
    const fetchMock = stubTickets();

    await fetchTickets("tx_session=abc");

    expect(String(fetchMock.mock.calls[0][0])).not.toContain("?");
  });

  it("omits a blank filter rather than sending an empty value", async () => {
    // apps/web reads `?status=` as the empty string and would filter on it,
    // returning nothing.
    const fetchMock = stubTickets();

    await fetchTickets("c=1", { status: "", product: "mark8ly" });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.has("status")).toBe(false);
    expect(url.searchParams.get("product")).toBe("mark8ly");
  });

  it("forwards the caller's session cookie", async () => {
    const fetchMock = stubTickets();

    await fetchTickets("tx_session=abc123", { status: "open" });

    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("cookie")).toBe(
      "tx_session=abc123",
    );
  });
});

describe("ticketsQuery", () => {
  it("uses apps/web's param names verbatim", () => {
    expect(ticketsQuery({ product: "homechef" })).toBe("product=homechef");
  });

  it("is empty for no filters", () => {
    expect(ticketsQuery({})).toBe("");
  });
});

const VALID_ANALYTICS = {
  total: 10,
  open: 2,
  escalated: 3,
  ai_resolved: 5,
  avg_resolution_seconds: 60,
  csat: 4,
  resolved_rate: 0.5,
  feedback_count: 2,
  by_status: { closed: 8 },
  by_reason: null,
  by_tenant: { fanzone: 10 },
  tenant_names: {},
};

describe("fetchSupportAnalytics", () => {
  it("reads apps/web's proxy, which is what preserves the tenant names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID_ANALYTICS), { status: 200 }),
    );
    installFetchStub(fetchMock);

    const stats = await fetchSupportAnalytics("tx_session=abc");

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/admin/analytics/support",
    );
    expect(fetchMock.mock.calls[0][1].headers.cookie).toBe("tx_session=abc");
    expect(stats.total).toBe(10);
  });

  it("preserves a 501 so the analytics tab can report instrumentation-unavailable", async () => {
    installFetchStub(
      vi.fn().mockResolvedValue(new Response("", { status: 501 })),
    );

    await expect(fetchSupportAnalytics("c=1")).rejects.toMatchObject({
      name: "PlatformApiError",
      status: 501,
    });
  });
});

describe("fetchTicketDetail", () => {
  it("forwards the cookie and parses the detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ticket: {
            id: TICKET_ID,
            product_id: "mark8ly",
            tenant_id: "",
            ticket_number: "M8-1042",
            subject: "Payout missing",
            description: "Detail",
            status: "open",
            priority: "urgent",
            submitted_by_name: "Asha",
            submitted_by_email: "asha@example.com",
            resolved_at: null,
            created_at: "2026-08-10T04:00:00.000Z",
            updated_at: "2026-08-11T04:00:00.000Z",
          },
          replies: [],
        }),
        { status: 200 },
      ),
    );
    installFetchStub(fetchMock);

    const detail = await fetchTicketDetail(TICKET_ID, "tx_session=abc");
    expect(detail.ticket.ticketNumber).toBe("M8-1042");
    expect(fetchMock.mock.calls[0][1].headers.cookie).toBe("tx_session=abc");
  });

  it("carries a 404 status so the page can render not-found", async () => {
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      ),
    );
    await expect(fetchTicketDetail(TICKET_ID, "")).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ---- the platform API path (#269) --------------------------------------
//
// The console speaks two backends while both exist: `apps/web` when
// PLATFORM_API_ORIGIN is unset — the deployed state today — and the Go tickets
// module when it is set. These cover the switch itself, because the failure it
// guards against is silent: a console that quietly went on reading the old
// endpoint would pass every other test in this file.

const PLATFORM_ORIGIN = "http://platform-api.platform.svc.cluster.local";

// Hoisted, so the mock is in place before `./platform-api` is imported in any
// order. A per-test `vi.doMock` was tried first and applied inconsistently —
// the real module then ran and called next/headers' `cookies()` outside a
// request scope, which failed for a reason unrelated to what was under test.
const tokenState = vi.hoisted(() => ({
  value: null as string | null,
  /** The store could not answer at all — no encryption key, no database, a read
   *  that threw. Distinct from `value: null`, which is a session that simply
   *  has no row, and the two must NOT produce the same error. */
  storeUnavailable: false,
}));

// Mocked at the PACKAGE boundary rather than on lib/auth/platform-token, so
// `getPlatformApiToken` itself runs for real. Mocking the local module instead
// left the real one loaded, and it called next/headers' `cookies()` outside a
// request scope, failing for a reason unrelated to the test.
//
// The session carries a `sid` and NOT an access token: the tokens live in
// `operator_api_tokens` now, and `getPlatformApiToken` deliberately does not
// fall back to the cookie claims. A session with no `sid` is the "no token at
// all" case these tests use for the refusal path.
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: async () =>
    tokenState.value === null && !tokenState.storeUnavailable
      ? { sub: "operator-1", email: "operator@tesserix.test" }
      : {
          sub: "operator-1",
          email: "operator@tesserix.test",
          sid: "sid-1",
          exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        },
}));

// The store, doubled at its own boundary so no database is needed. The expiry
// is an hour out, so these exercise the transport rather than the renewal path
// — which has its own coverage in lib/auth/platform-token.test.ts.
vi.mock("./auth/operator-token-store", () => {
  const record = () => {
    if (tokenState.storeUnavailable) {
      return { outcome: "unavailable" as const, tokens: null };
    }
    if (tokenState.value === null) {
      return { outcome: "absent" as const, tokens: null };
    }
    return {
      outcome: "ok" as const,
      tokens: {
        accessToken: tokenState.value,
        accessExpiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: null,
      },
    };
  };
  return {
    readTokenRecord: async () => record(),
    readTokens: async () => record().tokens,
    saveTokens: async () => {},
  };
});

/** Stub the token so these test the transport, not the session. */
function withToken(token: string | null) {
  tokenState.value = token;
  tokenState.storeUnavailable = false;
}

/** The store itself cannot answer — the misconfigured-deployment and
 *  database-blip shapes, which no amount of signing in again fixes. */
function withUnavailableStore() {
  tokenState.value = null;
  tokenState.storeUnavailable = true;
}

/** go-shared's StandardResponse, which is what the module answers with. */
function envelope(data: unknown, meta?: unknown) {
  return {
    success: true,
    data,
    ...(meta ? { meta } : {}),
    timestamp: "2026-08-19T07:00:00Z",
    request_id: "test-1",
  };
}

const MODULE_TICKET = {
  id: "3f2a1c94-0000-4000-8000-000000000001",
  product_id: "mark8ly",
  tenant_id: "3f2a1c94-0000-4000-8000-0000000000aa",
  ticket_number: "M8-0001",
  subject: "Payouts delayed again",
  description: "Third week running.",
  status: "open",
  priority: "urgent",
  submitted_by_name: "Amber Rowe",
  submitted_by_email: "amber@amber.test",
  resolved_at: null,
  created_at: "2026-08-19T06:00:00Z",
  updated_at: "2026-08-19T06:30:00Z",
};

const MODULE_SUMMARY = {
  open: 3,
  in_progress: 1,
  resolved_this_week: 1,
  urgent_open: 1,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("./auth/platform-token");
});

describe("the platform API switch", () => {
  it("reads apps/web when PLATFORM_API_ORIGIN is unset", async () => {
    // The deployed state. Merging the migration must not change it — the
    // console has no Zitadel access token yet (ADR-003 D8), so a straight
    // swap would break the surface on deploy.
    vi.stubEnv("PLATFORM_API_ORIGIN", "");
    const seen: string[] = [];
    installFetchStub(async (url: string) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ summary: { open: 1, inProgress: 0, resolvedThisWeek: 0, urgentOpen: 0 }, rows: [] }),
        { status: 200 },
      );
    });

    const mod = await import("./platform-api");
    await mod.fetchTickets("cookie=1");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/api/admin/platform-tickets");
    expect(seen[0]).not.toContain("/v1/tickets");
  });

  it("composes the queue from two resources when it is set", async () => {
    // #269's answer in one assertion: the API serves domain resources and the
    // console does the screen composition. Two requests, not one.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const seen: string[] = [];
    installFetchStub(async (url: string) => {
      seen.push(String(url));
      const body = String(url).includes("/summary")
        ? envelope({ summary: MODULE_SUMMARY })
        : envelope({ tickets: [MODULE_TICKET] });
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const mod = await import("./platform-api");
    const page = await mod.fetchTickets("cookie=1");

    expect(seen.some((u) => u.includes("/v1/tickets?"))).toBe(true);
    expect(seen.some((u) => u.includes("/v1/tickets/summary"))).toBe(true);
    expect(seen.every((u) => u.startsWith(PLATFORM_ORIGIN))).toBe(true);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].ticketNumber).toBe("M8-0001");
    // snake_case on the wire, camelCase in the console.
    expect(page.summary).toEqual({
      open: 3,
      inProgress: 1,
      resolvedThisWeek: 1,
      urgentOpen: 1,
    });
  });

  it("does not narrow the summary when the listing is filtered", async () => {
    // The property the split exists to preserve: the headline numbers are a
    // property of the QUEUE, so they must not move as an operator narrows the
    // list. The API offers no way to filter the summary; this asserts the
    // console does not invent one.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const seen: string[] = [];
    installFetchStub(async (url: string) => {
      seen.push(String(url));
      const body = String(url).includes("/summary")
        ? envelope({ summary: MODULE_SUMMARY })
        : envelope({ tickets: [] });
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const mod = await import("./platform-api");
    await mod.fetchTickets("cookie=1", { status: "open", priority: "urgent" });

    const listing = seen.find((u) => u.includes("/v1/tickets?"))!;
    const summary = seen.find((u) => u.includes("/summary"))!;
    expect(listing).toContain("status=open");
    expect(listing).toContain("priority=urgent");
    expect(summary).not.toContain("status");
    expect(summary).not.toContain("priority");
  });

  it("sends the operator's bearer token, never a cookie", async () => {
    // The platform API takes a Zitadel token (ADR-003 D8). Replaying the
    // console's own session cookie would be meaningless to it — tx_session is
    // a JWE it cannot read and was deliberately not taught to.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    let headers: Record<string, string> = {};
    installFetchStub(async (url: string, init: RequestInit) => {
      headers = { ...(init.headers as Record<string, string>) };
      return new Response(JSON.stringify(envelope({ ticket: MODULE_TICKET, replies: [] })), {
        status: 200,
      });
    });

    const mod = await import("./platform-api");
    await mod.fetchTicketDetail(MODULE_TICKET.id, "tx_session=secret");

    expect(headers.authorization).toBe("Bearer access-token-1");
    expect(JSON.stringify(headers)).not.toContain("tx_session");
  });

  it("refuses to call the API when the session carries no token", async () => {
    // Rather than sending it unauthenticated and surfacing a 401 with nothing
    // an operator can act on. This is the state of every session today.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken(null);
    installFetchStub(async () => {
      throw new Error("no request should have been made");
    });

    const mod = await import("./platform-api");
    // Asserted on the message, not `toThrow(PlatformApiError)`: these tests
    // re-import the module after vi.resetModules(), so the class the fresh
    // module throws is a different identity from the one imported at the top
    // of this file. The message is what an operator would see anyway.
    await expect(mod.fetchTickets("cookie=1")).rejects.toThrow(
      /carries no platform API access token/,
    );
  });

  it("parses the module's detail payload with the existing parser", async () => {
    // The envelope is stripped by the transport; what is left is
    // `{ticket, replies}` — the shape parseTicketDetail already reads. This is
    // the equivalence #271 asks for, asserted from the console's side.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    installFetchStub(async () =>
      new Response(
        JSON.stringify(
          envelope({
            ticket: MODULE_TICKET,
            replies: [
              {
                id: "r-1",
                ticket_id: MODULE_TICKET.id,
                author_type: "platform_admin",
                author_name: "Operator",
                author_email: "op@tesserix.test",
                content: "On it.",
                created_at: "2026-08-19T07:00:00Z",
              },
            ],
          }),
        ),
        { status: 200 },
      ),
    );

    const mod = await import("./platform-api");
    const detail = await mod.fetchTicketDetail(MODULE_TICKET.id, "cookie=1");

    expect(detail.ticket.ticketNumber).toBe("M8-0001");
    expect(detail.ticket.resolvedAt).toBeNull();
    expect(detail.replies[0].authorType).toBe("platform_admin");
  });

  it("sends an idempotency key on every write", async () => {
    // A retried submission must land once. The API records the key in the same
    // transaction as the write, so a recorded key always corresponds to a
    // committed one.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const keys: string[] = [];
    installFetchStub(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      keys.push(headers["idempotency-key"]);
      return new Response(JSON.stringify(envelope({ reply: {}, ticket: MODULE_TICKET })), {
        status: 201,
      });
    });

    const mod = await import("./platform-api");
    await mod.postTicketReply(MODULE_TICKET.id, { content: "hi" }, "cookie=1");
    await mod.patchTicketStatus(MODULE_TICKET.id, "resolved", "cookie=1");

    expect(keys).toHaveLength(2);
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    // Distinct per request: the key identifies the request the operator made,
    // so a genuine second reply must not be mistaken for a retry of the first.
    expect(new Set(keys).size).toBe(2);
  });

  it("surfaces the API's own error code rather than a bare status", async () => {
    // "no such ticket" and "you do not hold the capability this action
    // requires" are different things and the console renders them differently.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    installFetchStub(async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: "FORBIDDEN", message: "you do not hold the capability this action requires" },
        }),
        { status: 403 },
      ),
    );

    const mod = await import("./platform-api");
    await expect(mod.fetchTickets("cookie=1")).rejects.toThrow(/FORBIDDEN/);
  });

  it("reads the audit log from the platform API when the origin is set", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const seen: string[] = [];
    installFetchStub(async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify(envelope({ entries: [], failures: [] })), {
        status: 200,
      });
    });

    const mod = await import("./platform-api");
    await mod.fetchEstateAuditLog("cookie=1", "all");

    expect(seen[0]).toContain("/v1/audit");
    expect(seen[0]).not.toContain("/api/admin/apps");
  });

  it("sends the product as ?source= and omits it for `all`", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const seen: string[] = [];
    installFetchStub(async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify(envelope({ entries: [], failures: [] })), {
        status: 200,
      });
    });

    const mod = await import("./platform-api");
    await mod.fetchEstateAuditLog("cookie=1", "mark8ly");
    await mod.fetchEstateAuditLog("cookie=1", "all");

    expect(seen[0]).toContain("source=mark8ly");
    expect(seen[1]).not.toContain("source=");
  });

  it("sends the same limit and window on the platform path as on the fallback", async () => {
    // The cutover's whole premise is that unsetting PLATFORM_API_ORIGIN is a
    // true rollback. An unbounded platform read asks every product for its
    // entire audit log, which the API truncates at 1 MiB mid-JSON and reports
    // as the generic "invalid response" — a different answer from the same
    // question, which is exactly what must not happen.
    const seen: string[] = [];
    const capture = async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify(envelope({ entries: [], failures: [] })), {
        status: 200,
      });
    };

    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    installFetchStub(capture);
    const mod = await import("./platform-api");
    await mod.fetchEstateAuditLog("cookie=1", "mark8ly");

    expect(seen[0]).toContain(`limit=${mod.AUDIT_LIMIT}`);
    expect(seen[0]).toContain(`since_hours=${mod.AUDIT_SINCE_HOURS}`);
    // The filter still travels with them.
    expect(seen[0]).toContain("source=mark8ly");
  });

  it("still reads apps/web's audit-logs route when the origin is unset", async () => {
    // Proves the fallback survives the cutover: an unset PLATFORM_API_ORIGIN
    // must keep hitting the endpoint this surface has always used.
    vi.stubEnv("PLATFORM_API_ORIGIN", "");
    const seen: string[] = [];
    installFetchStub(async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ entries: [], failures: [] }), { status: 200 });
    });

    const mod = await import("./platform-api");
    await mod.fetchEstateAuditLog("cookie=1", "all");

    expect(seen[0]).toContain("/api/admin/apps/all/audit-logs");
  });

  it("surfaces a 400 from an unknown source as an error, not an empty log", async () => {
    // A typo'd source must not read as "nothing happened" — the API refuses
    // an unknown source with a 400, and that refusal has to reach the caller.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    installFetchStub(async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: "INVALID_ARGUMENT", message: 'unknown source "typo-app"' },
        }),
        { status: 400 },
      ),
    );

    const mod = await import("./platform-api");
    await expect(mod.fetchEstateAuditLog("cookie=1", "typo-app")).rejects.toThrow(
      /unknown source/,
    );
  });
});

// ---------------------------------------------------------------------------
// The AI usage reads.
//
// There is no apps/web fallback to switch on here — the AI gateway postdates
// that app — so these cover what the transport does with the query: which
// params it sends, which it drops, and that the envelope's payload reaches the
// caller parsed rather than as `unknown`.
// ---------------------------------------------------------------------------

const AI_WINDOW = {
  key: "24h",
  from: "2026-08-19T07:00:00Z",
  to: "2026-08-20T07:00:00Z",
  bucket: "1h0m0s",
  bucket_seconds: 3600,
};

const AI_TOKENS = { input: 1200, output: 300, cached_input: 400 };

const AI_TOTALS = {
  requests: 12,
  tokens: AI_TOKENS,
  cost_usd: 0.42,
  ok_requests: 11,
  blocked_requests: 1,
  rate_limited_requests: 0,
  error_requests: 0,
  masked_requests: 2,
};

describe("the AI usage reads", () => {
  function stubOnce(payload: unknown): string[] {
    const seen: string[] = [];
    installFetchStub(async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify(envelope(payload)), { status: 200 });
    });
    return seen;
  }

  it("sends the window and parses the totals", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const seen = stubOnce({ window: AI_WINDOW, totals: AI_TOTALS, series: [] });

    const mod = await import("./platform-api");
    const summary = await mod.fetchAiUsageSummary({ window: "7d" });

    expect(seen[0]).toContain("/v1/ai/usage/summary?window=7d");
    expect(summary.totals.costUsd).toBeCloseTo(0.42);
    expect(summary.totals.tokens.cachedInput).toBe(400);
  });

  it("drops a blank filter rather than sending an empty value", async () => {
    // The API refuses parameters it does not read (#307), and `product=`
    // would filter on the empty string — an answer of zero that looks like a
    // quiet window rather than a bad request.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const seen = stubOnce({ window: AI_WINDOW, totals: AI_TOTALS, series: [] });

    const mod = await import("./platform-api");
    await mod.fetchAiUsageSummary({ window: "24h", product: "", provider: undefined });

    const url = new URL(seen[0]);
    expect(url.searchParams.get("window")).toBe("24h");
    expect(url.searchParams.has("product")).toBe(false);
    expect(url.searchParams.has("provider")).toBe(false);
  });

  it("sends the axis as `by`, alongside the filters", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const seen = stubOnce({
      window: AI_WINDOW,
      by: "provider",
      rows: [
        {
          key: "anthropic",
          requests: 9,
          tokens: AI_TOKENS,
          cost_usd: 0.4,
          error_requests: 0,
          blocked_requests: 1,
        },
      ],
    });

    const mod = await import("./platform-api");
    const breakdown = await mod.fetchAiUsageBreakdown("provider", { product: "kora" });

    const url = new URL(seen[0]);
    expect(url.pathname).toBe("/v1/ai/usage/breakdown");
    expect(url.searchParams.get("by")).toBe("provider");
    expect(url.searchParams.get("product")).toBe("kora");
    expect(breakdown.rows[0].key).toBe("anthropic");
  });

  it("caps the events tail and forwards the outcome filter", async () => {
    // The tail is a capped read, not a page: the limit is the console's, not
    // the caller's, so a surface cannot ask the API for the whole month.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    const seen = stubOnce({ window: AI_WINDOW, events: [] });

    const mod = await import("./platform-api");
    await mod.fetchAiUsageEvents({ window: "24h" }, "guardrail_blocked");

    const url = new URL(seen[0]);
    expect(url.searchParams.get("limit")).toBe(String(mod.AI_EVENTS_LIMIT));
    expect(url.searchParams.get("outcome")).toBe("guardrail_blocked");
  });

  it("surfaces the API's refusal of an unknown window", async () => {
    // 422 rather than a blank page: the surface renders the message, and an
    // operator who hand-edited the URL is told what was wrong with it.
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken("access-token-1");
    installFetchStub(async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: "INVALID_ARGUMENT", message: '"90d" is not a window: use 24h, 7d or 30d' },
        }),
        { status: 422 },
      ),
    );

    const mod = await import("./platform-api");
    await expect(mod.fetchAiUsageSummary({ window: "90d" })).rejects.toThrow(/is not a window/);
  });

  it("refuses to call the API without an operator token", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", PLATFORM_ORIGIN);
    withToken(null);
    const seen = stubOnce({ window: AI_WINDOW, totals: AI_TOTALS, series: [] });

    const mod = await import("./platform-api");
    await expect(mod.fetchAiUsageGuardrails()).rejects.toThrow(/access token/);
    expect(seen).toHaveLength(0);
  });
});

describe("platformRequestWithMeta", () => {
  it("returns data and meta separately", async () => {
    // vi.stubEnv, not a direct process.env write: the AI-usage block above
    // stubs the env the same way, and a bare assignment here would leak into
    // whichever test runs next in this file.
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    // The prior "refuses to call the API without an operator token" test
    // leaves the shared tokenState at null; without this the request rejects
    // before the fetch mock is ever reached.
    withToken("access-token-1");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { opportunities: [] },
          // `paginationCursorMeta` for the CRM queues' own shape, plus a
          // `limit` this test also round-trips: `platformRequestWithMeta`
          // hands `meta` back untouched, whatever fields the producer sent,
          // so this fixture is not asserting the shape is EXACTLY the cursor
          // convention — it is asserting the transport drops nothing.
          meta: { ...paginationCursorMeta({ total: 7, preceding_count: 0 }), limit: 100 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    installFetchStub(fetchMock);

    const { platformRequestWithMeta } = await import("./platform-api");
    const result = await platformRequestWithMeta("crm due", "/v1/crm/queues/due?limit=100");

    expect(result.data).toEqual({ opportunities: [] });
    expect(result.meta).toEqual({ total: 7, preceding_count: 0, limit: 100 });
  });

  it("returns an undefined meta when the envelope carries none", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { opportunities: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { platformRequestWithMeta } = await import("./platform-api");
    const result = await platformRequestWithMeta("crm due", "/v1/crm/queues/due");
    expect(result.meta).toBeUndefined();
  });
});

describe("the no-operator-token signal", () => {
  it("marks the error when the session has no token row", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken(null);
    const { platformRequestWithMeta, PlatformApiError } = await import("./platform-api");
    const caught = await platformRequestWithMeta("tickets", "/v1/tickets").catch((e) => e);
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect(caught.noOperatorToken).toBe(true);
  });

  it("does NOT mark an ordinary API failure", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "nope" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { platformRequestWithMeta } = await import("./platform-api");
    const caught = await platformRequestWithMeta("tickets", "/v1/tickets").catch((e) => e);
    expect(caught.status).toBe(403);
    expect(caught.noOperatorToken).toBe(false);
  });

  it("does NOT mark a missing origin", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "");
    const { platformRequestWithMeta } = await import("./platform-api");
    const caught = await platformRequestWithMeta("tickets", "/v1/tickets").catch((e) => e);
    expect(caught.noOperatorToken).toBe(false);
  });

  // The branch's own failure mode, wearing better clothes. With
  // OPERATOR_TOKEN_ENCRYPT_KEY unset the callback's write fails the same check
  // this read did, so "sign in again" would be an instruction that can never
  // work — offered to every operator, on every session, forever. A
  // tesserix-postgres blip is the same shape for a few seconds. Both must stay
  // ordinary errors.
  it("does NOT mark a store that could not answer at all", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withUnavailableStore();
    const { platformRequestWithMeta, PlatformApiError } = await import("./platform-api");
    const caught = await platformRequestWithMeta("tickets", "/v1/tickets").catch((e) => e);
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect(caught.noOperatorToken).toBe(false);
    // And it must not borrow the marked case's copy either: this session may
    // well have a token row, and saying it does not would be a second untruth.
    expect(caught.message).not.toContain("carries no platform API access token");
  });
});

describe("fetchKoraAiMetricsPage", () => {
  const KORA_DATA = {
    window: { from: "2026-08-01T00:00:00Z", to: "2026-08-28T00:00:00Z" },
    outcomes: { attempts: 1, needs_human: 0, by_kind: {} },
    users: [],
  };

  /**
   * Pins the helper choice: this endpoint's pagination lives in the
   * envelope's `meta`, a sibling of `data` — never inside `data` itself, and
   * `KORA_DATA` above carries no `pagination` field to prove it. If this
   * function were changed back to call `platformRequest` (which discards
   * `meta` — see that function's own doc comment), `meta` would never reach
   * `parseKoraAiMetricsPagination` and this assertion on the parsed pager
   * would fail, not merely a log line saying the wrong helper ran.
   */
  it("reads pagination from the envelope's meta, not from data", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(envelope(KORA_DATA, paginationInMeta({ total: 2, limit: 50 }))), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await fetchKoraAiMetricsPage(1);

    expect(result.pagination).toEqual({ page: 1, limit: 50, total: 2 });
  });

  it("reflects the requested page in the parsed pagination, since meta carries no page field", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(envelope(KORA_DATA, paginationInMeta({ total: 90, limit: 50 }))), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await fetchKoraAiMetricsPage(2);

    expect(result.pagination).toEqual({ page: 2, limit: 50, total: 90 });
  });
});

/**
 * The `entities` module's counterpart to the `fetchKoraAiMetricsPage` pin
 * above: this producer's pagination lives INSIDE `data`, not in `meta` — the
 * opposite convention, exercised at the same transport level so both halves
 * of the table in `platformRequest`'s doc comment are pinned by a test, not
 * only asserted in prose.
 */
describe("fetchProductEntities", () => {
  it("reads pagination from data.pagination, not from meta", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            envelope(
              paginationInsideData(
                { data: [{ id: "u1", source: "kora", type: "users", label: "mahesh" }] },
                { page: 1, limit: 50, total: 1 },
              ),
            ),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await fetchProductEntities("kora", "users");

    expect(result.pagination).toEqual({ page: 1, limit: 50, total: 1 });
    expect(result.data[0]?.label).toBe("mahesh");
  });
});

/**
 * The onboarding funnel's federated read (#404). Two things are pinned here
 * and nowhere else: the `source` parameter — the API refuses a request
 * without one, because a funnel is one product's stages and not the estate's
 * — and the 501, which is the answer this deployment actually gives today.
 */
describe("fetchOnboardingFunnel", () => {
  const FUNNEL_DATA = {
    started: 3,
    completed: 1,
    median_completion_seconds: null,
    last_24h: { started: 1, completed: 0 },
    window: { from: "2026-08-01T00:00:00Z", to: "2026-08-30T00:00:00Z" },
  };

  it("names the product it is asking about", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope(FUNNEL_DATA)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    installFetchStub(fetchMock);

    const funnel = await fetchOnboardingFunnel("mark8ly");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://platform-api.test/v1/onboarding/funnel?source=mark8ly",
    );
    expect(funnel.stages).toEqual([
      { stage: "started", count: 3 },
      { stage: "completed", count: 1 },
    ]);
  });

  it("keeps the 501 status, so a parked federation never reads as an empty funnel", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: { code: "not_implemented", message: "no product declares an onboarding funnel" },
          }),
          { status: 501, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(fetchOnboardingFunnel("mark8ly")).rejects.toMatchObject({ status: 501 });
  });
});

/**
 * The declarations read (#447/#448). What is pinned here is the URL, because
 * the whole value of this read is that it replaces a literal: a query
 * parameter added by a future edit would make it a filtered view of the
 * estate's declarations while still looking like the whole list, and
 * platform-api answers 400 for any parameter on this route.
 */
describe("fetchPlatformSources", () => {
  const INDEX = {
    endpoints: { onboarding: ["mark8ly"], outbox: ["mark8ly"] },
    entities: { tenants: ["mark8ly"], users: ["kora"] },
  };

  it("asks the unparameterised route and returns the deployment's declarations", async () => {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope(INDEX)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    installFetchStub(fetchMock);

    const sources = await fetchPlatformSources();

    expect(fetchMock.mock.calls[0][0]).toBe("http://platform-api.test/v1/platform/sources");
    expect(sources.endpoints.onboarding).toEqual(["mark8ly"]);
  });

  it("fails rather than answering an empty estate when the read fails", async () => {
    // A caller must never read a failure as "nothing is declared": one is the
    // absence of a fact, the other is a fact.
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    installFetchStub(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, error: { code: "unavailable", message: "down" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(fetchPlatformSources()).rejects.toMatchObject({ status: 503 });
  });
});

/**
 * The session list's federated read (#448).
 *
 * The query is asserted against the API CONTRACT — platform-api's
 * `sessionsParameters` — rather than against whatever this module happens to
 * emit: the route rejects an unknown parameter with a 400 rather than ignoring
 * it, so a renamed key here is a broken surface, not a harmless difference.
 */
describe("fetchOnboardingSessions", () => {
  const ROW = {
    id: "sess-1",
    email: "merchant@example.com",
    status: "in_progress",
    created_at: "2026-08-28T09:00:00Z",
    last_activity_at: "2026-08-29T11:30:00Z",
    idle_hours: 21.5,
    abandoned: false,
    completed_at: null,
    tenant_id: null,
  };

  function respond(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    installFetchStub(fetchMock);
    return fetchMock;
  }

  /** The query the module actually sent, as parameters rather than as a
   *  string — key order is not part of the contract and asserting it would
   *  pin the implementation instead. */
  function sentQuery(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams {
    return new URL(fetchMock.mock.calls[0][0] as string).searchParams;
  }

  it("names the product and the page size, and sends nothing else by default", async () => {
    const fetchMock = respond(envelope([ROW], { total: 1, limit: 50 }));

    await fetchOnboardingSessions("mark8ly");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/onboarding/sessions");
    expect([...sentQuery(fetchMock).keys()].sort()).toEqual(["limit", "source"]);
    expect(sentQuery(fetchMock).get("source")).toBe("mark8ly");
    expect(sentQuery(fetchMock).get("limit")).toBe("50");
  });

  it("sends each filter under the API's own parameter name", async () => {
    const fetchMock = respond(envelope([], { total: 0, limit: 50 }));

    await fetchOnboardingSessions("mark8ly", {
      status: "in_progress",
      createdFrom: "2026-08-01T00:00:00Z",
      createdTo: "2026-08-30T00:00:00Z",
      abandoned: "true",
    });

    const query = sentQuery(fetchMock);
    expect(query.get("status")).toBe("in_progress");
    expect(query.get("created_from")).toBe("2026-08-01T00:00:00Z");
    expect(query.get("created_to")).toBe("2026-08-30T00:00:00Z");
    expect(query.get("abandoned")).toBe("true");
  });

  it("drops a blank filter rather than filtering on the empty string", async () => {
    const fetchMock = respond(envelope([], { total: 0, limit: 50 }));

    await fetchOnboardingSessions("mark8ly", { status: "", createdFrom: undefined });

    expect(sentQuery(fetchMock).has("status")).toBe(false);
    expect(sentQuery(fetchMock).has("created_from")).toBe(false);
  });

  it("omits page 1 and sends every later page", async () => {
    const first = respond(envelope([], { total: 0, limit: 50 }));
    await fetchOnboardingSessions("mark8ly", {}, 1);
    expect(sentQuery(first).has("page")).toBe(false);

    const third = respond(envelope([], { total: 0, limit: 50 }));
    await fetchOnboardingSessions("mark8ly", {}, 3);
    expect(sentQuery(third).get("page")).toBe("3");
  });

  it("reads the rows from data and the pagination from meta", async () => {
    const fetchMock = respond(envelope([ROW], { total: 137, limit: 50 }));

    const page = await fetchOnboardingSessions("mark8ly");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(page.total).toBe(137);
    expect(page.limit).toBe(50);
    expect(page.rows[0]?.email).toBe("merchant@example.com");
  });

  it("keeps a 400 status, so a mistyped window reaches the page as advice", async () => {
    respond(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message:
            "created_from must be an RFC 3339 timestamp, for example 2026-08-01T00:00:00Z",
        },
      },
      400,
    );

    await expect(
      fetchOnboardingSessions("mark8ly", { createdFrom: "2026-08-01" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects rather than returning an empty list when the body is not a list", async () => {
    // The empty-versus-unreadable rule, at the console's end of the wire.
    //
    // Asserted on the message rather than `toThrow(PlatformApiError)`, for the
    // reason recorded on "the platform API switch" above.
    //
    // This file has TWO file-scope `afterEach` hooks, and only the second one
    // calls `vi.resetModules()`. That is the one that matters here: a
    // freshly-resolved module throws a `PlatformApiError` whose class identity
    // is not the one imported at the top of this file, so an identity check
    // would fail for a reason that has nothing to do with what is asserted.
    //
    // Named as the second rather than as "this file's `afterEach`", which is
    // what stood here: a reader who takes that singular literally finds the
    // hook at the top of the file, which does NOT reset modules, and reasons
    // about the wrong teardown. Pinned in `lib/claims.guard.test.ts`.
    respond(envelope(null, { total: 0, limit: 50 }));
    await expect(fetchOnboardingSessions("mark8ly")).rejects.toThrow(
      /an unreadable list is not an empty one/,
    );
  });
});

describe("fetchProductKpis", () => {
  /** The console-facing wire shape, as the kpis handler's own Go test pins it:
   *  the metrics map sits directly in the envelope's `data`. */
  function kpisResponse(metrics: unknown) {
    return new Response(JSON.stringify(envelope(metrics)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function stubFetch(response: Response) {
    vi.stubEnv("PLATFORM_API_ORIGIN", "http://platform-api.test");
    withToken("access-token-1");
    const fetchMock = vi.fn().mockResolvedValue(response);
    installFetchStub(fetchMock);
    return fetchMock;
  }

  it("reads the metrics map straight out of `data`, with no second wrapper", async () => {
    // The one shape mistake this read can make. There are two `data` wrappers
    // on the path and only one of them survives to here: §8.6's is unwrapped
    // by `service.go` on the product's response, and go-shared's is unwrapped
    // by `platformRequest`. A parser expecting one more would reject every
    // real answer.
    stubFetch(kpisResponse({ orders_today: 128, payments_health: "healthy" }));

    expect(await fetchProductKpis("mark8ly")).toEqual({
      orders_today: 128,
      payments_health: "healthy",
    });
  });

  it("sends the source as an encoded query parameter", async () => {
    const fetchMock = stubFetch(kpisResponse({ n: 1 }));

    await fetchProductKpis("mark8ly");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://platform-api.test/v1/kpis?source=mark8ly");
  });

  it("escapes a source rather than letting it add a parameter", async () => {
    // The endpoint answers 400 for a query parameter it does not read, so an
    // unescaped `&` would turn a bad slug into a confusing rejection about the
    // wrong thing.
    const fetchMock = stubFetch(kpisResponse({ n: 1 }));

    await fetchProductKpis("mark8ly&source=kora");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("http://platform-api.test/v1/kpis?source=mark8ly%26source%3Dkora");
  });

  it("preserves a 501 so the surface can report instrumentation-unavailable", async () => {
    // Kora's live answer: the product reports no headline metrics yet.
    stubFetch(
      new Response(
        JSON.stringify({ success: false, error: { code: "NOT_IMPLEMENTED", message: "no metrics" } }),
        { status: 501, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(fetchProductKpis("kora")).rejects.toMatchObject({ status: 501 });
  });

  it("preserves a 503 as a distinct status, not as the 501", async () => {
    // An outage must never reach the page as "no metrics" — see
    // `writeReadError`, which calls that the more dangerous mistake.
    //
    // The removal-sensitive half of that guard. Its pair, "leaves a 503 as an
    // error — the dangerous direction" in `kpis.test.ts`, asserts the STATE an
    // operator ends up in but is enforced by `resolveState`, so it survives
    // `kpisReadError` being deleted. This one fails the moment the status
    // stops reaching the caller. Neither covers the other; keep both.
    stubFetch(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "unreachable" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(fetchProductKpis("mark8ly")).rejects.toMatchObject({ status: 503 });
  });
});
