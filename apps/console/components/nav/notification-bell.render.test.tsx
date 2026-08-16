// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { NotificationBell } from "./notification-bell";

function mockFeed(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// SWR keeps a module-level cache keyed on the fetch URL, which leaks between
// these tests since they all poll the same "/api/notifications" key. Each
// render gets its own Map-backed provider so one test's response can never
// satisfy another's `waitFor`.
function renderBell() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NotificationBell />
    </SWRConfig>,
  );
}

const ITEM = {
  id: "merchant_reply:1",
  kind: "merchant_reply",
  ticketId: "5f0b2c34-0000-0000-0000-000000000000",
  ticketNumber: "M8-1042",
  productId: "mark8ly",
  subject: "Payout missing",
  actor: "Asha Pillai",
  at: "2026-08-16T00:00:00.000Z",
};

describe("NotificationBell", () => {
  it("shows the unread count in the button's accessible name", async () => {
    mockFeed({ items: [ITEM], unread: 1, lastSeenAt: null });
    renderBell();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /1 unread/i })).toBeInTheDocument(),
    );
  });

  it("links each item to the ticket by uuid", async () => {
    mockFeed({ items: [ITEM], unread: 1, lastSeenAt: null });
    renderBell();
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole("button", { name: /unread/i }));
    await user.click(screen.getByRole("button", { name: /unread/i }));
    const link = await screen.findByRole("link", { name: /M8-1042/ });
    expect(link).toHaveAttribute(
      "href",
      "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000",
    );
  });

  it("says nothing is waiting when the feed is empty", async () => {
    mockFeed({ items: [], unread: 0, lastSeenAt: "2026-08-16T00:00:00.000Z" });
    renderBell();
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole("button"));
    await user.click(screen.getByRole("button"));
    expect(await screen.findByText(/nothing waiting/i)).toBeInTheDocument();
  });

  it("renders quiet and disabled when the data plane is parked", async () => {
    // 501 — the window before the chart change deploys. It must not read as
    // a failure, and it must not keep retrying.
    mockFeed({ error: "not_configured" }, 501);
    renderBell();
    await waitFor(() =>
      expect(screen.getByRole("button")).toBeDisabled(),
    );
  });

  it("treats a redirect to login as unavailable rather than as data", async () => {
    // The middleware matcher covers /api/*, so an expired session answers a
    // poll with HTML, not JSON.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html><html><body>login</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    renderBell();
    await waitFor(() => expect(screen.getByRole("button")).toBeDisabled());
  });

  it("marks read on open even when unread is 0 and lastSeenAt is null", async () => {
    // A fresh operator has no console_notification_reads row, so
    // lastSeenAt is null and countUnread (lib/notifications.ts) returns 0
    // regardless of how many items exist. If the POST were gated on
    // `unread > 0`, it would never fire, lastSeenAt would never get set,
    // and the badge would be stuck at zero forever. The POST must fire on
    // every open, unconditionally.
    mockFeed({ items: [ITEM], unread: 0, lastSeenAt: null });
    renderBell();
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole("button"));

    await user.click(screen.getByRole("button"));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall?.[0]).toBe("/api/notifications");
    });
  });

  it("renders unavailable rather than throwing when the body is malformed", async () => {
    // A 200 with a shape that isn't a NotificationFeed (e.g. `items` isn't
    // an array) is the one boundary where a wrong payload would otherwise
    // break the sidebar on every console page.
    mockFeed({ items: "nope", unread: 1, lastSeenAt: null });
    renderBell();
    await waitFor(() => expect(screen.getByRole("button")).toBeDisabled());
  });

  it("stops polling once the feed is unavailable", async () => {
    vi.useFakeTimers();
    mockFeed({ error: "not_configured" }, 501);
    renderBell();

    await act(async () => {
      await vi.waitFor(() => expect(screen.getByRole("button")).toBeDisabled());
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance well past the 60s refresh interval. A future edit that
    // reintroduces polling on the unavailable branch should fail this.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
