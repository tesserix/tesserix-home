// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { ConsoleCommandPalette } from "./command-palette";

const PROPS = {
  capabilities: ["read"],
  enforceCapabilities: true,
  toolsBaseDomain: "tesserix.app",
};

function mockSearch(items: unknown[], status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ items }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockClear();
});

describe("ConsoleCommandPalette", () => {
  it("opens on the keyboard shortcut and closes on Escape", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("opens from the trigger button too, for operators who do not know the chord", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("offers the built ticket queue and does not offer a pending route", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "tickets",
    );
    // platform.tickets is built; platform.liveChat is pending and must render
    // disabled rather than navigable.
    const queue = await screen.findByRole("option", { name: /Platform · Tickets/i });
    expect(queue).not.toBeDisabled();
  });

  it("renders a pending route disabled", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "break",
    );
    const pending = await screen.findByRole("option", { name: /Break Glass/i });
    expect(pending).toBeDisabled();
  });

  it("does not fetch tickets for a one-character query", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "p",
    );
    await new Promise((r) => setTimeout(r, 350));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still shows routes and tools when the ticket search fails", async () => {
    // The palette must not become unusable because the database is unreachable.
    mockSearch([], 500);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "tickets",
    );
    expect(
      await screen.findByRole("option", { name: /Platform · Tickets/i }),
    ).toBeInTheDocument();
  });
});
