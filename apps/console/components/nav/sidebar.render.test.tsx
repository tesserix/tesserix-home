import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import { ConsoleSidebar, railFor } from "./sidebar";

afterEach(() => {
  pathname.current = "/";
});

// The sidebar renders only for authenticated users, so nothing exercised it
// before production did. `NavIcon` resolves an icon key through a registry —
// a key with no entry yields `undefined`, which React reports as
// "Element type is invalid ... got: undefined".
describe("railFor", () => {
  it("defaults to the platform rail", () => {
    // The console's own home page is the platform dashboard. Showing a product
    // rail there was the original bug: the header said Platform, the nav said
    // Kora.
    expect(railFor("/")).toBe("platform");
    expect(railFor("/admin/dashboard")).toBe("platform");
  });

  it("switches to the product rail inside that product's routes", () => {
    expect(railFor("/admin/apps/kora")).toBe("kora");
    expect(railFor("/admin/apps/kora/foods")).toBe("kora");
  });
});

describe("ConsoleSidebar", () => {
  it("renders the grouped platform rail by default", () => {
    render(<ConsoleSidebar />);

    expect(screen.getByText("Platform")).toBeInTheDocument();
    expect(screen.getByText("Operate")).toBeInTheDocument();
    expect(screen.getByText("Health")).toBeInTheDocument();
    expect(screen.getByText("Governance")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Break-glass")).toBeInTheDocument();
  });

  it("sends web-hosted surfaces to the web origin, not an in-app route", () => {
    // Every platform surface still lives in apps/web. Linking them relatively
    // would route to a page the console does not have.
    render(<ConsoleSidebar />);

    const dashboard = screen.getByText("Dashboard").closest("a");
    expect(dashboard?.getAttribute("href")).toMatch(/^https?:\/\/.+\/admin\/dashboard$/);
  });

  it("switches to Kora's rail inside Kora routes", () => {
    pathname.current = "/admin/apps/kora/foods";
    render(<ConsoleSidebar />);

    expect(screen.getByText("Kora")).toBeInTheDocument();
    expect(screen.getByText("Food index")).toBeInTheDocument();
    expect(screen.getByText("Product")).toBeInTheDocument();
    // Kora's surfaces are not migrated either, so they leave for web too —
    // but the rail itself is served from the shared package.
    expect(screen.queryByText("Governance")).toBeNull();
  });
});
