import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConsolePageHeader } from "./page-header";

// The dashboard page renders ConsolePageHeader, and nothing covered it. In
// production the authenticated page failed with React's "Element type is
// invalid ... got: undefined", which is what a missing runtime export looks
// like — a class of failure typecheck and build both pass.
describe("ConsolePageHeader", () => {
  it("renders a title and description", () => {
    render(<ConsolePageHeader title="Platform" description="Estate health." />);

    expect(screen.getByText("Platform")).toBeInTheDocument();
    expect(screen.getByText("Estate health.")).toBeInTheDocument();
  });

  it("marks exactly one breadcrumb as the current page", () => {
    // An hrefless intermediate crumb must not also claim aria-current, or a
    // screen reader announces two "current page" positions in one trail.
    const { container } = render(
      <ConsolePageHeader
        title="Paneer bhurji"
        breadcrumbs={[
          { label: "Kora", href: "/kora" },
          { label: "Food index" },
          { label: "Paneer bhurji" },
        ]}
      />,
    );

    expect(screen.getByText("Kora")).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("renders a two-crumb trail's first crumb as a link back, and the last as plain text", () => {
    // Regression: the ticket detail page once passed a single-item trail, so
    // its only crumb became the (unlinked) current page and the href was
    // silently dropped — there was no way back to the list. A trail with a
    // parent and a current page must keep the parent navigable.
    render(
      <ConsolePageHeader
        title="Ticket detail"
        breadcrumbs={[
          { label: "Tickets", href: "/platform/tickets" },
          { label: "TCK-42" },
        ]}
      />,
    );

    const parentLink = screen.getByRole("link", { name: "Tickets" });
    expect(parentLink).toHaveAttribute("href", "/platform/tickets");

    // BreadcrumbPage (the current-page crumb) renders as a <span>, not an
    // <a> — it must not be reachable as an actual link, even though it
    // carries role="link" for styling parity.
    const currentCrumb = screen.getByText("TCK-42");
    expect(currentCrumb.tagName).not.toBe("A");
    expect(currentCrumb).toHaveAttribute("aria-current", "page");
  });

  it("renders a single-crumb trail with no navigable link at all", () => {
    // Pins the component's actual contract: the last crumb is always the
    // current page, even when it's the only crumb — so a caller passing just
    // one item gets an unlinked label, not a link. Callers must supply the
    // full trail, parent included.
    render(<ConsolePageHeader title="Support" breadcrumbs={[{ label: "Tickets", href: "/platform/tickets" }]} />);

    expect(document.querySelector("a")).toBeNull();
    const crumb = screen.getByText("Tickets");
    expect(crumb).toHaveAttribute("aria-current", "page");
    expect(crumb).toHaveAttribute("aria-disabled", "true");
  });
});
