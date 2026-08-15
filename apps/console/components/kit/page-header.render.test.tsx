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
});
