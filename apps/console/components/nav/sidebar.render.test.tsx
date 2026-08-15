import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { ConsoleSidebar } from "./sidebar";

// The sidebar renders only for authenticated users, so nothing exercised it
// before production did. `NavIcon` resolves an icon key through a registry —
// a key with no entry yields `undefined`, which React reports as
// "Element type is invalid ... got: undefined".
describe("ConsoleSidebar", () => {
  it("renders every nav entry with its icon", () => {
    render(<ConsoleSidebar />);

    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Food index")).toBeInTheDocument();
    expect(screen.getByText("Users")).toBeInTheDocument();
  });
});
