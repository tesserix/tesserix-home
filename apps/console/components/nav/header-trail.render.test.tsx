// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/platform/tickets" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import { HeaderTrail } from "./header-trail";

describe("HeaderTrail", () => {
  it("renders nothing on a top-level surface", () => {
    pathname.current = "/platform/tickets";
    const { container } = render(<HeaderTrail />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links back to the queue from a ticket detail path", () => {
    pathname.current = "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000";
    render(<HeaderTrail />);
    expect(screen.getByRole("link", { name: "Tickets" })).toHaveAttribute(
      "href",
      "/platform/tickets",
    );
  });

  it("does not render the leaf, which the page's own title already carries", () => {
    pathname.current = "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000";
    render(<HeaderTrail />);
    expect(screen.queryByText(/5f0b2c34/)).not.toBeInTheDocument();
  });
});
