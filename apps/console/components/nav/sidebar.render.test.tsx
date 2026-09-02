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
    expect(screen.getByText("AI")).toBeInTheDocument();
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

  it("links every one of Kora's built pages", () => {
    // This used to assert that EVERY Kora surface was pending — true when
    // Kora's IA was migrated and none of its pages were, and linking them
    // would have been 404s the previously-inert switcher was hiding.
    //
    // All three entries are now built: Food index and Users first, and
    // Overview (this task) last — the promise `pending: true` made in
    // `routes.ts` is now kept for the whole rail, not just two of its three
    // entries. Named individually rather than counted, so the next entry to
    // land fails here and gets a decision rather than a silent pass.
    pathname.current = "/kora/foods";
    render(<ConsoleSidebar />);

    const overview = screen.getByText("Overview").closest("a");
    expect(overview).not.toBeNull();
    expect(overview).toHaveAttribute("href", "/kora");

    const foodIndex = screen.getByText("Food index").closest("a");
    expect(foodIndex).not.toBeNull();
    expect(foodIndex).toHaveAttribute("href", "/kora/foods");

    const users = screen.getByText("Users").closest("a");
    expect(users).not.toBeNull();
    expect(users).toHaveAttribute("href", "/kora/users");
  });

  it("collapses a group from a real button, and says so", async () => {
    // A button, not a div with a click handler: the console has already had
    // orphan-`role` ARIA violations flagged, and the fix for those was to use
    // the element whose semantics are already right.
    const user = userEvent.setup();
    render(<ConsoleSidebar />);

    const ai = screen.getByRole("button", { name: "AI" });
    expect(ai).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("AI usage")).toBeVisible();

    await user.click(ai);

    expect(ai).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("AI usage")).not.toBeVisible();
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
    await user.click(screen.getByRole("button", { name: "AI" }));
    first.unmount();

    render(<ConsoleSidebar />);

    expect(screen.getByRole("button", { name: "AI" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("AI usage")).not.toBeVisible();
  });

  it("opens the group holding the current route, whatever was stored", () => {
    // A rail that hides where you are is worse than a long rail: it removes
    // the one landmark saying which part of the console this is.
    window.localStorage.setItem(
      COLLAPSED_GROUPS_KEY,
      JSON.stringify(["Operate", "AI", "Governance", "Growth"]),
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
    expect(screen.getByRole("button", { name: "AI" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("survives unreadable stored state rather than losing the rail", () => {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, "{not json");
    render(<ConsoleSidebar />);

    expect(screen.getByRole("button", { name: "AI" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  // Two rail entries rendered `aria-current="page"` at once on the reviews
  // queue, because `/platform/secrets` is a segment-boundary prefix of
  // `/platform/secrets/reviews`. Every row asserts the dark entry as well as
  // the lit one: only the pairing catches an over-eager narrowing, which
  // would put Secrets out on its own pages too.
  describe.each([
    { path: "/platform/secrets", lit: "Secrets", dark: "Secrets reviews" },
    { path: "/platform/secrets/new", lit: "Secrets", dark: "Secrets reviews" },
    {
      path: "/platform/secrets/openbao/marketplace-api/stripe-key",
      lit: "Secrets",
      dark: "Secrets reviews",
    },
    {
      path: "/platform/secrets/reviews",
      lit: "Secrets reviews",
      dark: "Secrets",
    },
    {
      path: "/platform/secrets/reviews/42",
      lit: "Secrets reviews",
      dark: "Secrets",
    },
  ])("on $path", ({ path, lit, dark }) => {
    it(`marks only ${lit} as the current page`, () => {
      pathname.current = path;
      render(<ConsoleSidebar />);

      expect(screen.getByRole("link", { name: lit })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(
        screen.getByRole("link", { name: dark }),
      ).not.toHaveAttribute("aria-current");
    });
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
