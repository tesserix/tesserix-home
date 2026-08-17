import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import { ConsoleSidebar, railFor } from "./sidebar";

afterEach(() => {
  pathname.current = "/";
  window.localStorage.clear();
});

const COLLAPSED_GROUPS_KEY = "console.sidebar.collapsed-groups";

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
    // CONSOLE paths, not apps/web's /admin/apps/kora — the console serves its
    // own path shape (see consolePath in console-core).
    expect(railFor("/kora")).toBe("kora");
    expect(railFor("/kora/foods")).toBe("kora");
    // A bare prefix must not match: /korax is not Kora's rail.
    expect(railFor("/korax")).toBe("platform");
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

  it("does not link unbuilt surfaces anywhere — including to the old admin", () => {
    // apps/web is being retired. Linking there would make the console a shell
    // around the app it replaces, and linking in-app would 404. Pending
    // entries are therefore not anchors at all.
    render(<ConsoleSidebar />);

    // Dashboard is no longer pending — it is the console root, and is
    // asserted as a real link below.
    expect(screen.getByText("Break-glass").closest("a")).toBeNull();
    expect(document.querySelectorAll('a[href*="localhost:3002"]')).toHaveLength(0);
    expect(document.querySelectorAll('a[href^="http"]')).toHaveLength(0);
  });

  it("links Dashboard to the console root — the surface actually lives there", () => {
    // platform.dashboard is built: the console root ("/") is the estate map
    // plus the internal tools directory. Un-pending it without linking it
    // would still leave no way back to the console home.
    render(<ConsoleSidebar />);

    expect(screen.getByText("Dashboard").closest("a")).toHaveAttribute("href", "/");
  });

  it("switches context when the switcher is used, without navigating away", async () => {
    // The switcher changes which rail is shown, not the location. Every surface
    // in both rails is still served by apps/web, so navigating on select would
    // eject the operator from the console just to look at a rail.
    const user = userEvent.setup();
    render(<ConsoleSidebar />);

    expect(screen.getByText("Operate")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /platform/i }));
    await user.click(screen.getByRole("menuitem", { name: /kora/i }));

    expect(screen.getByText("Food index")).toBeInTheDocument();
    expect(screen.queryByText("Operate")).toBeNull();
  });

  it("marks Kora's surfaces pending too — its IA is migrated, its pages are not", () => {
    // Linking these in-app would be five 404s, which the previously-inert
    // switcher was hiding.
    pathname.current = "/kora/foods";
    render(<ConsoleSidebar />);

    expect(screen.getByText("Food index").closest("a")).toBeNull();
    expect(screen.getAllByText("soon").length).toBeGreaterThan(0);
  });

  it("collapses a group from a real button, and says so", async () => {
    // A button, not a div with a click handler: the console has already had
    // orphan-`role` ARIA violations flagged, and the fix for those was to use
    // the element whose semantics are already right.
    const user = userEvent.setup();
    render(<ConsoleSidebar />);

    const health = screen.getByRole("button", { name: "Health" });
    expect(health).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Uptime")).toBeVisible();

    await user.click(health);

    expect(health).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Uptime")).not.toBeVisible();
  });

  it("keeps pending entries visible-but-disabled inside an open group", () => {
    // Collapsing is not a way to hide unbuilt surfaces — that is a different
    // decision, and this is not it. An expanded group still shows every SOON
    // entry, still as a non-navigable span.
    render(<ConsoleSidebar />);

    const breakGlass = screen.getByText("Break-glass");
    expect(breakGlass).toBeVisible();
    expect(breakGlass.closest("a")).toBeNull();
    expect(breakGlass.closest("[aria-disabled='true']")).not.toBeNull();
  });

  it("remembers a collapsed group across a remount", async () => {
    const user = userEvent.setup();
    const first = render(<ConsoleSidebar />);
    await user.click(screen.getByRole("button", { name: "Health" }));
    first.unmount();

    render(<ConsoleSidebar />);

    expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("Uptime")).not.toBeVisible();
  });

  it("opens the group holding the current route, whatever was stored", () => {
    // A rail that hides where you are is worse than a long rail: it removes
    // the one landmark saying which part of the console this is.
    window.localStorage.setItem(
      COLLAPSED_GROUPS_KEY,
      JSON.stringify(["Operate", "Health", "Governance", "Growth"]),
    );
    pathname.current = "/platform/audit-log";

    render(<ConsoleSidebar />);

    expect(screen.getByRole("button", { name: "Governance" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Audit log")).toBeVisible();
    // Guards the guard: the other groups honour the stored preference, so the
    // assertion above is about the active group and not about ignoring storage.
    expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("survives unreadable stored state rather than losing the rail", () => {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, "{not json");
    render(<ConsoleSidebar />);

    expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("switches to Kora's rail inside Kora routes", () => {
    pathname.current = "/kora/foods";
    render(<ConsoleSidebar />);

    expect(screen.getByText("Kora")).toBeInTheDocument();
    expect(screen.getByText("Food index")).toBeInTheDocument();
    expect(screen.getByText("Product")).toBeInTheDocument();
    // Kora's surfaces are not migrated either, so they leave for web too —
    // but the rail itself is served from the shared package.
    expect(screen.queryByText("Governance")).toBeNull();
  });
});
