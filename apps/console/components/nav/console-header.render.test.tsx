// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleHeader } from "./console-header";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPS = {
  name: "Mahesh Sangawar",
  email: "mahesh.sangawar@tesserix.app",
  capabilities: ["read"],
  showCapabilities: true,
};

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
});
