// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
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
});
