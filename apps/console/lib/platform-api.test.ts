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
