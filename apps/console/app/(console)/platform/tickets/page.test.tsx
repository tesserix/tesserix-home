import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { fetchSupportAnalytics, fetchTickets, PlatformApiError } from "@/lib/platform-api";
import { QueueList, type QueueItem } from "@/components/kit/queue-list";
import type { Ticket } from "@/lib/tickets";
import TicketQueue, {
  analyticsState,
  QUEUE_EMPTY_MESSAGE,
  QUEUE_FILTERS,
  queueState,
  readQueueFilters,
  statusOf,
  toFilterValues,
} from "./page";

// The page reads the operator's cookie to call apps/web server-to-server.
vi.mock("next/headers", () => ({
  cookies: async () => ({ toString: () => "tx_session=abc" }),
}));

// A partial mock — every test but the reauth-required ones below calls
// straight through to the real implementation, still exercised against
// `stubUpstream`'s fetch mock exactly as before. Only `fetchTickets`/
// `fetchSupportAnalytics` need to be individually overridable, to simulate
// the platform-API branch's `noOperatorToken` rejection without actually
// wiring `PLATFORM_API_ORIGIN` through this test file's fetch stub.
vi.mock("@/lib/platform-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform-api")>();
  return {
    ...actual,
    fetchTickets: vi.fn(actual.fetchTickets),
    fetchSupportAnalytics: vi.fn(actual.fetchSupportAnalytics),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Undoes a `mockRejectedValueOnce`/`mockImplementationOnce` override from a
  // reauth-required test — `once` queues drain themselves, but restoring
  // here guards against a leftover queued rejection reaching an unrelated
  // test if one is ever added after such an override without consuming it.
  vi.mocked(fetchTickets).mockClear();
  vi.mocked(fetchSupportAnalytics).mockClear();
});

// The queue previously resolved its state with `triageState(error, null)`,
// which returns only instrumentation-unavailable | error | ready. Zero rows
// therefore reported `ready`, the list rendered an empty <ul>, and the
// emptyMessage was dead code. These tests assert the states are reachable
// rather than eyeballing them.

const ROW: QueueItem = {
  key: "mark8ly#412",
  title: "Cannot log in after password reset",
  product: "mark8ly",
  waitingSince: "2026-08-16T09:00:00.000Z",
  severity: "normal",
  href: "/platform/tickets/2f6c",
};

describe("queueState", () => {
  it("reports empty — not ready — when nothing is waiting and nothing is filtered", () => {
    expect(queueState({ error: null, rows: [], filtered: false })).toEqual({ kind: "empty" });
  });

  it("reports filtered-empty when a filter is active and nothing matches", () => {
    expect(queueState({ error: null, rows: [], filtered: true })).toEqual({
      kind: "filtered-empty",
    });
  });

  it("reports ready once there is a row", () => {
    expect(queueState({ error: null, rows: [ROW], filtered: false })).toEqual({ kind: "ready" });
  });

  it("maps a 501 to instrumentation-unavailable, not to error", () => {
    // A parked data plane must never read as a failure an operator can retry.
    expect(
      queueState({ error: new PlatformApiError("parked", 501), rows: [], filtered: false }),
    ).toEqual({ kind: "instrumentation-unavailable" });
  });

  it("maps a real failure to error, not to instrumentation-unavailable", () => {
    // Guards the guard above: a blanket mapping would pass that test too.
    expect(
      queueState({ error: new PlatformApiError("boom", 500), rows: [], filtered: false }),
    ).toEqual({ kind: "error", message: "boom" });
  });

  it("prefers the error over the empty row count", () => {
    // A failed fetch also has zero rows; reporting "nothing waiting" there
    // would tell an operator the queue is clear when it is simply unread.
    expect(
      queueState({ error: new PlatformApiError("boom", 500), rows: [], filtered: false }).kind,
    ).toBe("error");
  });
});

describe("the queue's empty states actually render", () => {
  function renderQueue(state: ReturnType<typeof queueState>, onClearFilters?: () => void) {
    render(
      <QueueList
        items={[]}
        state={state}
        emptyMessage={QUEUE_EMPTY_MESSAGE}
        onClearFilters={onClearFilters}
      />,
    );
  }

  it("reaches the emptyMessage that used to be unreachable", () => {
    renderQueue(queueState({ error: null, rows: [], filtered: false }));

    expect(screen.getByText(QUEUE_EMPTY_MESSAGE)).toBeInTheDocument();
    // Not an empty <ul>, which is what shipped.
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("offers a way out of a filtered no-match instead of the empty copy", () => {
    const onClearFilters = vi.fn();
    renderQueue(queueState({ error: null, rows: [], filtered: true }), onClearFilters);

    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText(QUEUE_EMPTY_MESSAGE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("renders a 501 as a parked notice rather than as empty or as a failure", () => {
    renderQueue(queueState({ error: new PlatformApiError("parked", 501), rows: [], filtered: false }));

    expect(screen.getByRole("status")).toHaveTextContent("Instrumentation unavailable");
    expect(screen.queryByText(QUEUE_EMPTY_MESSAGE)).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The page itself: filters, the status column, and the analytics tab.
//
// These render the server component's output directly. Vitest has no RSC
// boundary, so the client halves (FilterBar, QueueList, SurfaceTabs) render
// inline — which is what makes "did the filter reach the API" and "does a
// parked analytics endpoint take the queue down" assertable at all.
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/platform/tickets",
  useSearchParams: () => new URLSearchParams(),
}));

const TICKET: Ticket = {
  id: "5f0b2c34-0000-0000-0000-000000000000",
  productId: "mark8ly",
  tenantId: "",
  ticketNumber: "M8-1042",
  subject: "Payouts stuck since Tuesday",
  status: "in_progress",
  priority: "urgent",
  submittedByName: "Bondi Store",
  submittedByEmail: "ops@bondi.example",
  createdAt: "2026-08-15T09:00:00.000Z",
  updatedAt: "2026-08-15T09:30:00.000Z",
};

const SUMMARY = { open: 23, inProgress: 4, resolvedThisWeek: 11, urgentOpen: 4 };

const ANALYTICS = {
  total: 120,
  open: 14,
  escalated: 30,
  ai_resolved: 76,
  avg_resolution_seconds: 5400,
  csat: 4.2,
  resolved_rate: 0.83,
  feedback_count: 41,
  by_status: { closed: 90, active: 30 },
  by_reason: null,
  by_tenant: { "11111111-1111-1111-1111-111111111111": 120 },
  tenant_names: { "11111111-1111-1111-1111-111111111111": "Asha Threads" },
};

interface StubOptions {
  rows?: readonly unknown[];
  analyticsStatus?: number;
}

/** Routes the two server-to-server reads the page makes, independently. */
function stubUpstream({ rows = [TICKET], analyticsStatus = 200 }: StubOptions = {}) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/admin/analytics/support")) {
      return analyticsStatus === 200
        ? new Response(JSON.stringify(ANALYTICS), { status: 200 })
        : new Response("", { status: analyticsStatus });
    }
    return new Response(
      JSON.stringify({
        summary: SUMMARY,
        rows: rows.map((row) => ({
          ...(row as Record<string, unknown>),
          product_id: (row as Ticket).productId,
          ticket_number: (row as Ticket).ticketNumber,
          created_at: (row as Ticket).createdAt,
        })),
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ticketsUrl(fetchMock: ReturnType<typeof stubUpstream>): URL {
  const call = fetchMock.mock.calls.find(
    ([input]) => !String(input).includes("/analytics/support"),
  );
  if (!call) throw new Error("the page never called the tickets endpoint");
  return new URL(String(call[0]));
}

async function renderQueuePage(searchParams: Record<string, string | string[] | undefined>) {
  render(await TicketQueue({ searchParams: Promise.resolve(searchParams) }));
}

describe("readQueueFilters", () => {
  it("reads the three params apps/web has always accepted", () => {
    expect(
      readQueueFilters({ status: "open", priority: "urgent", product: "mark8ly" }),
    ).toEqual({ status: "open", priority: "urgent", product: "mark8ly" });
  });

  it("drops a value no descriptor offers rather than forwarding it", () => {
    // Forwarding it would return zero rows and render `filtered-empty`, which
    // says "nothing matches" when the truth is "that filter does not exist".
    expect(readQueueFilters({ status: "banana" })).toEqual({});
  });

  it("ignores a repeated param, which arrives as an array", () => {
    expect(readQueueFilters({ status: ["open", "closed"] })).toEqual({});
  });

  it("ignores params this surface never declared", () => {
    // A URL is untrusted input; a saved view must not smuggle state in.
    expect(readQueueFilters({ tenant: "acme", limit: "9999" })).toEqual({});
  });

  it("offers every product in the estate, not only those with tickets today", () => {
    const product = QUEUE_FILTERS.find((d) => d.key === "product");
    expect(product?.options?.map((o) => o.value)).toContain("dwellm8");
    expect(product?.options?.length).toBeGreaterThan(3);
  });
});

describe("statusOf", () => {
  it("labels and tones the row's workflow state", () => {
    expect(statusOf(TICKET)).toEqual({ label: "In progress", tone: "warning" });
  });
});

describe("toFilterValues", () => {
  it("shows the bar only what the server actually applied", () => {
    expect(toFilterValues({ status: "open" })).toEqual({ status: "open" });
  });
});

describe("the queue page's filters", () => {
  it("sends the URL's filters upstream as query params", async () => {
    const fetchMock = stubUpstream();

    await renderQueuePage({ status: "open", priority: "urgent", product: "mark8ly" });

    const url = ticketsUrl(fetchMock);
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("priority")).toBe("urgent");
    expect(url.searchParams.get("product")).toBe("mark8ly");
  });

  it("sends nothing when the URL carries no filters", async () => {
    // Guards the guard: a page that dropped the params entirely would still
    // pass a test that only asserted the endpoint was called.
    const fetchMock = stubUpstream();

    await renderQueuePage({});

    expect(ticketsUrl(fetchMock).search).toBe("");
  });

  it("does not forward a filter value the surface does not offer", async () => {
    const fetchMock = stubUpstream({ rows: [] });

    await renderQueuePage({ status: "banana" });

    expect(ticketsUrl(fetchMock).search).toBe("");
    // And the queue reads as empty, not as "nothing matches your filter".
    expect(screen.getByText(QUEUE_EMPTY_MESSAGE)).toBeInTheDocument();
  });

  it("renders filtered-empty with a way out when an active filter matches nothing", async () => {
    stubUpstream({ rows: [] });

    await renderQueuePage({ status: "closed" });

    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText(QUEUE_EMPTY_MESSAGE)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Clear filters" }).length).toBeGreaterThan(0);
  });

  it("shows the row's status beside its severity", async () => {
    stubUpstream();

    await renderQueuePage({});

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("In progress")).toBeInTheDocument();
    expect(within(row).getByText("critical")).toBeInTheDocument();
  });
});

describe("analyticsState", () => {
  it("parks the tab on a 501 rather than reporting a failure", () => {
    expect(
      analyticsState({ error: new PlatformApiError("parked", 501), data: null }),
    ).toEqual({ kind: "instrumentation-unavailable" });
  });

  it("still reports a real failure as an error", () => {
    // Guards the guard: a blanket mapping to instrumentation-unavailable would
    // pass the test above and hide every genuine outage.
    expect(
      analyticsState({ error: new PlatformApiError("boom", 502), data: null }).kind,
    ).toBe("error");
  });
});

describe("the analytics tab", () => {
  it("parks itself on a 501 without taking the queue down", async () => {
    // Two different databases behind two different endpoints. `Promise.all`
    // here would reject the whole render on the analytics failure.
    stubUpstream({ analyticsStatus: 501 });

    await renderQueuePage({});

    // The queue still rendered its row and its summary.
    expect(screen.getByText(TICKET.subject)).toBeInTheDocument();
    expect(screen.getByText("23")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));

    expect(screen.getAllByText("Not measured").length).toBe(8);
    expect(screen.getAllByText(/Instrumentation unavailable/i).length).toBeGreaterThan(0);
  });

  it("renders the eight KPIs and the tenant names the proxy resolved", async () => {
    stubUpstream();

    await renderQueuePage({});
    fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));

    expect(screen.getByText("Total conversations")).toBeInTheDocument();
    expect(screen.getByText("4.2 / 5")).toBeInTheDocument();
    expect(screen.getByText("1h 30m")).toBeInTheDocument();
    // The whole reason analytics is read through apps/web rather than otto.
    expect(screen.getByText("Asha Threads")).toBeInTheDocument();
    expect(screen.queryByText("Not measured")).toBeNull();
  });
});

describe("when the session has no platform token", () => {
  it("prompts sign-in on the queue tab, carrying the operator's filters back", async () => {
    stubUpstream({ rows: [] });
    vi.mocked(fetchTickets).mockRejectedValueOnce(
      new PlatformApiError("tickets: this session carries no platform API access token (ADR-003 D8)", undefined, {
        noOperatorToken: true,
      }),
    );

    await renderQueuePage({ status: "open" });

    const link = screen.getByRole("link", { name: /sign in again/i });
    expect(decodeURIComponent(link.getAttribute("href")!.split("returnTo=")[1])).toBe(
      "/platform/tickets?status=open",
    );
  });

  // Queue and Analytics are independent reads and independent tabs — a
  // no-token session can fail either without the other reflecting it, same
  // guarantee `does not blank the other queue` pins for the CRM surface.
  it("does not show a sign-in prompt on the queue tab when only analytics has no token", async () => {
    stubUpstream();
    vi.mocked(fetchSupportAnalytics).mockRejectedValueOnce(
      new PlatformApiError("support analytics: no platform API access token", undefined, {
        noOperatorToken: true,
      }),
    );

    await renderQueuePage({});

    expect(screen.getByText(TICKET.subject)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign in again/i })).toBeNull();
  });

  // The panel hands the SAME state to three `RankedBars` (by status, by
  // reason, by tenant) plus eight `StatTile`s. Without suppression each
  // `RankedBars` would render its own full "sign in again" callout — three
  // identical prompts under one tab, the exact stacking #300 task 4 exists
  // to prevent.
  it("shows exactly one sign-in prompt on the analytics tab, not three", async () => {
    stubUpstream();
    vi.mocked(fetchSupportAnalytics).mockRejectedValueOnce(
      new PlatformApiError("support analytics: no platform API access token", undefined, {
        noOperatorToken: true,
      }),
    );

    await renderQueuePage({});
    fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));

    expect(screen.getAllByRole("link", { name: /sign in again/i })).toHaveLength(1);
  });
});
