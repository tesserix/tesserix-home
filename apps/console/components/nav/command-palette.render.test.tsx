// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { ConsoleCommandPalette } from "./command-palette";
import type { DirectoryTool } from "@/lib/tools-directory";

// Stands in for what the console layout now fetches from the database via
// `readToolsDirectory()`. This palette no longer reads `INTERNAL_TOOLS`
// itself, so any tool the tests below expect to find (Grafana, Kubecost,
// Cost estimator) has to be supplied here rather than assumed from the
// code literal in `@tesserix/console-core`.
const TOOL_ROWS: DirectoryTool[] = [
  { id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity platform.", note: null, groupKey: "identity" },
  { id: "2", name: "Grafana", subdomain: "grafana", purpose: "Dashboards and charts over the metrics pipeline.", note: null, groupKey: "observability" },
  { id: "3", name: "Kargo", subdomain: "kargo", purpose: "Promotes images between stages.", note: null, groupKey: "delivery" },
  { id: "4", name: "Kubecost", subdomain: "kubecost", purpose: "Cluster spend by namespace and workload.", note: null, groupKey: "cost" },
  { id: "5", name: "Cost estimator", subdomain: "costestimator", purpose: "Models the cost of a change before making it.", note: null, groupKey: "cost" },
  { id: "6", name: "Docs", subdomain: "docs", purpose: "Engineering documentation.", note: null, groupKey: "reference" },
];

const PROPS = {
  // A full-access operator, so these tests exercise the palette rather than the
  // capability filter. #261 reduced `read` to console entry, so a `read`-only
  // fixture now legitimately sees no routes at all — which would make every
  // assertion below fail for a reason that has nothing to do with the palette.
  // `visibleTo`'s own behaviour is covered in lib/search.test.ts.
  capabilities: ["read", "crm", "support", "platform"],
  enforceCapabilities: true,
  toolsBaseDomain: "tesserix.app",
  tools: TOOL_ROWS,
};

// `/api/search` returns entries already built by `ticketEntry` server-side —
// the client takes `items` as `SearchEntry[]` and does not re-derive them from
// raw ticket rows. A fixture shaped like a `TicketSearchRow` renders nothing.
const TICKET_ROW = {
  id: "ticket:11111111-1111-1111-1111-111111111111",
  kind: "ticket",
  label: "TKT-1042 — Payout missing",
  hint: "Priya Raman · open",
  href: "/platform/tickets/11111111-1111-1111-1111-111111111111",
  external: false,
  disabled: false,
  keywords: ["TKT-1042", "Payout missing", "Priya Raman", "priya@example.com", "mark8ly"],
  capability: "read",
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
      "custom",
    );
    // `platform.customDomains` is pending and stays at the `read` capability,
    // so it is the right fixture for pending-ness alone. This used to use
    // `platform.breakGlass`, which now declares `rotate-credentials` and is
    // correctly filtered out for this read-only operator — a different
    // property, tested below.
    const pending = await screen.findByRole("option", { name: /Custom Domains/i });
    expect(pending).toBeDisabled();
  });

  it("finds a camelCase route by the words its label displays", async () => {
    // Regression test for the labelling-rule fix: `value` is now built from
    // the same split-and-capitalize rule the label renders with, so typing
    // the words an operator reads on screen ("custom domains") must find
    // `platform.customDomains` even though nothing in the route id itself
    // contains a space.
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "custom domains",
    );
    expect(await screen.findByRole("option", { name: /Custom Domains/i })).toBeInTheDocument();
  });

  it("does not offer a route whose capability the operator lacks", async () => {
    // The gap this closed: every entry used to declare "read", the console
    // entry ticket every internal operator holds, so an operator with no
    // rotation rights still saw break-glass in their results and could
    // navigate there. The surface refuses, but the palette should not have
    // advertised it.
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "break glass",
    );
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Break Glass/i })).not.toBeInTheDocument(),
    );
  });

  // Nothing else in this file renders a ticket ROW — the "ticket queue" test
  // above matches the *route* of that name. So this positive control exists to
  // give the fail-closed test below something to actually be the absence of.
  // Without it, that test passes whether or not the filter is wired, because a
  // negative `waitFor` is satisfied on the first tick, long before the 250ms
  // debounce has fired.
  it("renders a matching ticket row", async () => {
    mockSearch([TICKET_ROW]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "payout",
    );
    expect(
      await screen.findByRole("option", { name: /TKT-1042/ }, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it("hides ticket rows too when the claims list is empty", async () => {
    // `visibleTo` fails closed on purpose: a bug that drops the claims list
    // must not turn into full access. That posture used to be uneven — routes
    // and tools went through it, ticket rows did not — so dropped claims would
    // have emptied the palette of route labels while still rendering customer
    // data. Ticket rows are the only entries carrying any: subject, submitter
    // name, submitter email.
    //
    // Every operator inside the console holds `read`, so this filters nothing
    // in normal use; it matters only in the failure the guard exists for.
    mockSearch([TICKET_ROW]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} capabilities={[]} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "payout",
    );
    // Wait for the debounced fetch to have actually happened, so absence below
    // means "filtered out" rather than "not requested yet".
    await waitFor(() => expect(global.fetch).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() =>
      expect(screen.queryByText(/Searching tickets/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("option", { name: /TKT-1042/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/priya@example.com/)).not.toBeInTheDocument();
  });

  it("offers it to an operator who holds that capability", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(
      <ConsoleCommandPalette {...PROPS} capabilities={["read", "rotate-credentials"]} />,
    );
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "break glass",
    );
    expect(await screen.findByRole("option", { name: /Break Glass/i })).toBeInTheDocument();
  });

  it("does not match every tool when the query is the literal word 'tool'", async () => {
    // Pinning test for a mistake in the previous fix: `CommandItem`'s value
    // was set to `entry.id` (`tool:${subdomain}`), and the primitive matches
    // queries against `value`, so typing the bare word "tool" matched every
    // tool entry regardless of its actual name or purpose. None of the tool
    // names, subdomains or groups in `tools.ts` contain the substring
    // "tool", so a correctly-scoped `value` returns zero tool options here.
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "tool",
    );
    // Wait past the debounced ticket search's "Searching tickets…"
    // placeholder — that row is itself a disabled `option`, and asserting
    // the option count while it is still showing would count it, not a
    // false-positive tool match.
    // The debounced ticket search's "Searching tickets…" placeholder is
    // itself a disabled `option`, unconditionally rendered while in flight
    // — wait for it to clear before counting options, or it is what the
    // count would see, not a false-positive tool match.
    await waitFor(() =>
      expect(screen.queryByText(/searching tickets/i)).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/nothing matching/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("does not claim nothing matches while a full list of routes is showing", async () => {
    // Regression test for the "Nothing matching..." + full result list bug:
    // up to `@tesserix/web` 1.8.1 `CommandEmpty` counted only registered
    // *visible* items and disabled `CommandItem`s never registered — so with
    // an empty query (which matches everything, including the pending/disabled
    // routes) it saw zero registrations and rendered its message directly
    // above a screenful of matching rows. This test outlived two
    // implementations of the fix — a hand-computed empty state, and now 2.1.0
    // counting what it actually rendered — and is unchanged across both,
    // which is what makes it the specification rather than either of them.
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByRole("dialog");

    expect(await screen.findAllByRole("option")).not.toHaveLength(0);
    expect(screen.queryByText(/nothing matching/i)).not.toBeInTheDocument();
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
    // Keyboard-driven on purpose, and it is the test that outlived the
    // workaround it was written for. It used to prove `forwardToListbox`
    // re-dispatched the key onto the listbox node; now it proves the same
    // keystroke reaches `@tesserix/web` 2.1.0's own handler on `Command`'s
    // wrapper, with nothing in between. The assertion never changed, which is
    // the point — a click-only test would not have caught either failure.
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

  it("highlights nothing until the operator navigates, then moves down the list", async () => {
    // "cost" matches exactly two tools — Kubecost and Cost estimator — which
    // is what makes the highlight's movement observable at all.
    // `data-active` is the primitive's own attribute for "this is the
    // highlighted item" (read from the compiled `@tesserix/web` source,
    // `CommandItem`'s `"data-active": isActive ? "true" : "false"` — not
    // `aria-selected`, which tracks the *selected* value instead).
    //
    // The first assertion changed in `@tesserix/web` 2.1.0 and the new
    // behaviour is the correct one. Up to 1.8.1 `CommandInput`'s `onChange`
    // set the highlight to the first matching item on every keystroke, so
    // something was always pre-highlighted and a bare Enter fired it. That is
    // the combobox anti-pattern where typing arms a destructive-looking
    // default the operator never chose — and it is half of the stale-Enter
    // bug, since the pre-set highlight outlived the query that produced it.
    // 2.1.0 leaves `activeValue` undefined until an arrow key, and Enter is a
    // no-op while nothing is active. This test now pins THAT, deliberately:
    // it is a behaviour change, not a regression absorbed quietly.
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

    // Typing alone arms nothing.
    expect(kubecost).toHaveAttribute("data-active", "false");
    expect(estimator).toHaveAttribute("data-active", "false");

    await user.keyboard("{ArrowDown}");

    expect(kubecost).toHaveAttribute("data-active", "true");
    expect(estimator).toHaveAttribute("data-active", "false");

    // GUARDS THE GUARD: one ArrowDown landing on the first item passes just as
    // happily if the highlight is stuck there. This is the assertion that
    // fails if it stops moving.
    await user.keyboard("{ArrowDown}");

    expect(kubecost).toHaveAttribute("data-active", "false");
    expect(estimator).toHaveAttribute("data-active", "true");
  });

  it("does nothing on Enter while nothing is highlighted", async () => {
    // The other half of the 2.1.0 change, asserted on its own so the pair
    // above cannot be read as cosmetic. A palette that navigates on a bare
    // Enter — to whichever row happened to sort first — is how an operator
    // ends up somewhere they did not ask for.
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(
      await screen.findByPlaceholderText(/search routes, tools and tickets/i),
      "tickets",
    );
    await screen.findByRole("option", { name: /Platform · Tickets/i });
    await user.keyboard("{Enter}");

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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
      "custom",
    );
    const pending = await screen.findByRole("option", { name: /Custom Domains/i });
    await user.click(pending);

    expect(push).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("keeps the search input's focus ring inside the dialog's clipping box", async () => {
    // Class-presence proxy only: jsdom does not lay out or paint, so it
    // cannot confirm the ring itself stays visually inside the dialog panel
    // (that requires a real browser). This just pins the utility class that
    // makes it so — a negative outline-offset draws the ring inward instead
    // of past the input's box edge, where `CommandDialog`'s `overflow-hidden`
    // would otherwise clip it. See the comment on `CommandInput` in
    // command-palette.tsx for the full mechanism.
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    const input = await screen.findByPlaceholderText(/search routes, tools and tickets/i);
    expect(input.className).toContain("focus-visible:outline-offset-[-2px]");
  });

  it("offers a tool that exists only in the database", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(
      <ConsoleCommandPalette
        {...PROPS}
        tools={[
          { id: "9", name: "Tempo", subdomain: "tempo", purpose: "Traces.", note: null, groupKey: "observability" },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /search/i }));

    // Tempo is in no literal anywhere. If this passes, the palette is reading
    // the database rather than console-core.
    expect(await screen.findByText("Tempo")).toBeInTheDocument();
  });
});
