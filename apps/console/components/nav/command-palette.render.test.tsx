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

  it("finds a camelCase route by the words its label displays", async () => {
    // Regression test for the labelling-rule fix: `value` is now built from
    // the same split-and-capitalize rule the label renders with, so typing
    // the words an operator reads on screen ("break glass") must find
    // `platform.breakGlass` even though nothing in the route id itself
    // contains a space.
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "break glass",
    );
    expect(await screen.findByRole("option", { name: /Break Glass/i })).toBeInTheDocument();
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

  it("navigates on ArrowDown + Enter, then closes and clears the query", async () => {
    // Keyboard-driven on purpose: this is the path that proves
    // forwardToListbox (command-palette.tsx) actually works, not just that
    // clicking an option works. ArrowDown here bubbles from the search
    // input to Command's wrapper and gets re-dispatched onto the listbox
    // node, which is what lets CommandList's own onKeyDown move its private
    // `activeValue` — see the workaround's comment for why a click-only
    // test would not have caught a regression here.
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "tickets",
    );
    await screen.findByRole("option", { name: /Platform · Tickets/i });
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(push).toHaveBeenCalledWith("/platform/tickets");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    // Reopening must not show the previous search — the query was cleared.
    mockSearch([]);
    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
    ).toHaveValue("");
  });

  it("moves the highlight on ArrowDown", async () => {
    // "cost" matches exactly two tools — Kubecost and Cost estimator — which
    // is what makes the highlight's movement observable: a single-match
    // query is already active on its only item before any key is pressed.
    // `data-active` is the primitive's own attribute for "this is the
    // highlighted item" (read from the compiled `@tesserix/web` source,
    // `CommandItem`'s `"data-active": isActive ? "true" : "false"` — not
    // `aria-selected`, which tracks the *selected* value instead).
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "cost",
    );
    const kubecost = await screen.findByRole("option", { name: /Kubecost/i });
    const estimator = await screen.findByRole("option", { name: /Cost estimator/i });

    expect(kubecost).toHaveAttribute("data-active", "true");
    expect(estimator).toHaveAttribute("data-active", "false");

    await user.keyboard("{ArrowDown}");

    expect(kubecost).toHaveAttribute("data-active", "false");
    expect(estimator).toHaveAttribute("data-active", "true");
  });

  it("opens a tool externally instead of pushing a route", async () => {
    mockSearch([]);
    vi.stubGlobal("open", vi.fn());
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "grafana",
    );
    const tool = await screen.findByRole("option", { name: /Grafana/i });
    await user.click(tool);

    expect(window.open).toHaveBeenCalledWith(
      "https://grafana.tesserix.app",
      "_blank",
      "noopener,noreferrer",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("does not navigate when a pending route is selected", async () => {
    mockSearch([]);
    vi.stubGlobal("open", vi.fn());
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "break",
    );
    const pending = await screen.findByRole("option", { name: /Break Glass/i });
    await user.click(pending);

    expect(push).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });
});
