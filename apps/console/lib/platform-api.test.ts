import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlatformApiError,
  fetchDashboard,
  parseDashboard,
  fetchSupportAnalytics,
  fetchTicketDetail,
  fetchTickets,
  postTicketReply,
  patchTicketStatus,
  ticketsQuery,
} from "./platform-api";

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

afterEach(() => {
  vi.unstubAllGlobals();
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
    vi.stubGlobal("fetch", fetchMock);

    await fetchDashboard("tx_session=abc123");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("cookie")).toBe("tx_session=abc123");
  });

  it("preserves a 501 so the surface can report instrumentation-unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 501 })),
    );

    await expect(fetchDashboard("c=1")).rejects.toMatchObject({ status: 501 });
  });

  it("preserves a 500 as a plain error, distinct from 501", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );

    await expect(fetchDashboard("c=1")).rejects.toMatchObject({ status: 500 });
  });

  it("surfaces a transport failure as a PlatformApiError with no status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const err = await fetchDashboard("c=1").catch((e) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect(err.status).toBeUndefined();
  });

  it("formats a non-Error rejection without an undefined message, keeping the cause", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("ECONNRESET"));

    const err = await fetchDashboard("c=1").catch((e) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect(err.message).toBe("dashboard: request failed (ECONNRESET)");
    expect(err.message).not.toContain("undefined");
    expect(err.cause).toBe("ECONNRESET");
  });

  it("surfaces a 200 carrying a non-JSON body as a PlatformApiError", async () => {
    // A proxy or ingress error page arrives as HTML with a 200; the typed
    // boundary must hold rather than leaking a raw SyntaxError.
    vi.stubGlobal(
      "fetch",
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
    vi.stubGlobal("fetch", fetchMock);

    await postTicketReply(TICKET_ID, { content: "On it." }, "tx_session=abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/admin/platform-tickets/${TICKET_ID}/replies`);
    expect(init.method).toBe("POST");
    expect(init.headers.origin).toBe("https://console.tesserix.app");
    expect(init.headers.cookie).toBe("tx_session=abc");
    expect(JSON.parse(init.body)).toEqual({ content: "On it." });
  });

  it("throws a PlatformApiError carrying the status on failure", async () => {
    vi.stubGlobal(
      "fetch",
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
    vi.stubGlobal("fetch", fetchMock);

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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);

    const stats = await fetchSupportAnalytics("tx_session=abc");

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/admin/analytics/support",
    );
    expect(fetchMock.mock.calls[0][1].headers.cookie).toBe("tx_session=abc");
    expect(stats.total).toBe(10);
  });

  it("preserves a 501 so the analytics tab can report instrumentation-unavailable", async () => {
    vi.stubGlobal(
      "fetch",
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
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchTicketDetail(TICKET_ID, "tx_session=abc");
    expect(detail.ticket.ticketNumber).toBe("M8-1042");
    expect(fetchMock.mock.calls[0][1].headers.cookie).toBe("tx_session=abc");
  });

  it("carries a 404 status so the page can render not-found", async () => {
    vi.stubGlobal(
      "fetch",
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
const tokenState = vi.hoisted(() => ({ value: null as string | null }));

// Mocked at the PACKAGE boundary rather than on lib/auth/platform-token, so
// `getPlatformApiToken` itself runs for real — including its defensive read of
// a field SessionClaims does not carry yet. Mocking the local module instead
// left the real one loaded, and it called next/headers' `cookies()` outside a
// request scope, failing for a reason unrelated to the test.
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: async () =>
    tokenState.value === null
      ? { sub: "operator-1", email: "operator@tesserix.test" }
      : {
          sub: "operator-1",
          email: "operator@tesserix.test",
          accessToken: tokenState.value,
          // An expiry an hour out, so these exercise the transport rather than
          // the renewal path. A session with no expiry is treated as expiring
          // and would send getPlatformApiToken to Zitadel — see
          // lib/auth/platform-token.test.ts, which covers that decision.
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
}));

/** Stub the token so these test the transport, not the session. */
function withToken(token: string | null) {
  tokenState.value = token;
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
    vi.stubGlobal("fetch", async (url: string) => {
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
    vi.stubGlobal("fetch", async (url: string) => {
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
    vi.stubGlobal("fetch", async (url: string) => {
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
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
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
    vi.stubGlobal("fetch", async () => {
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
    vi.stubGlobal("fetch", async () =>
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
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
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
    vi.stubGlobal("fetch", async () =>
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
});
