// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// ConsoleHeader now renders ConsoleCommandPalette, which calls next/navigation's
// useRouter — a hook that throws (not just returns null) outside a mounted
// AppRouterContext. Mocked rather than worked around in the component: see
// command-palette.render.test.tsx for the matching mock. It also renders
// HeaderTrail, which calls usePathname for the same reason.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/platform/tickets",
}));

import { ConsoleHeader, type ConsoleHeaderProps } from "./console-header";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPS: ConsoleHeaderProps = {
  name: "Mahesh Sangawar",
  email: "mahesh.sangawar@tesserix.app",
  capabilities: ["read", "crm", "support", "platform"],
  showCapabilities: true,
  tools: [],
  health: {
    state: "healthy",
    stale: false,
    checkedAt: "2026-08-23T12:00:00Z",
    reason: null,
    workloads: { total: 8, ready: 8 },
    databases: { total: 1, ready: 1 },
  },
};

function renderHeader(overrides: Partial<ConsoleHeaderProps> = {}) {
  return render(<ConsoleHeader {...PROPS} {...overrides} />);
}

describe("ConsoleHeader", () => {
  it("carries both the bell and the operator menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ items: [], unread: 0, lastSeenAt: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<ConsoleHeader {...PROPS} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /notifications/i })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Mahesh Sangawar/ }),
    ).toBeInTheDocument();
  });

  it("renders no page title of its own", () => {
    // Pages render ConsolePageHeader; a title here would give every surface two.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 501 })));
    const { container } = render(<ConsoleHeader {...PROPS} />);
    expect(container.querySelector("h1")).toBeNull();
  });

  // jsdom computes no layout, so this cannot confirm either panel is actually
  // on screen — it only pins the class that decides the direction. That is a
  // weaker guarantee than a real viewport check, but it is the guard that
  // would have caught both panels opening upward off a sticky header, which
  // the two tests above did not.
  it("opens both flyout panels downward, not upward off the sticky header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ items: [], unread: 0, lastSeenAt: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const user = userEvent.setup();
    render(<ConsoleHeader {...PROPS} />);

    await user.click(await screen.findByRole("button", { name: /notifications/i }));
    const bellPanel = await screen.findByRole("dialog", { name: /notifications/i });
    expect(bellPanel.className).toContain("top-full");
    expect(bellPanel.className).not.toContain("bottom-full");

    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    const operatorPanel = screen.getByRole("dialog", { name: /operator menu/i });
    expect(operatorPanel.className).toContain("top-full");
    expect(operatorPanel.className).not.toContain("bottom-full");
  });

  it("renders the health indicator", () => {
    // Threaded from the layout. If this stops rendering, every operator loses
    // the signal silently — nothing else on the page would look different.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 501 })));
    renderHeader({
      health: {
        state: "degraded",
        stale: false,
        checkedAt: null,
        reason: null,
        workloads: { total: 1, ready: 0 },
        databases: { total: 1, ready: 1 },
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/degraded/i);
  });
});
