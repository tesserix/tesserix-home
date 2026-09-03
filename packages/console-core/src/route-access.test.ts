import { describe, expect, it } from "vitest";
import { capabilityForPath, routeForPath } from "./route-access";
import { consolePath, routeCapability } from "./routes";

/**
 * Resolving a request path to the capability that guards it (#262).
 *
 * This is the ACCESS gate, so the thing under test is not "does it find a
 * route" but "can a path reach a surface without presenting its capability".
 */

describe("routeForPath", () => {
  it("resolves a surface's own path to that surface", () => {
    expect(routeForPath(consolePath("platform.crm"))).toBe("platform.crm");
  });

  // A detail page is not its own route entry. It must inherit the capability
  // of the surface it belongs to, or every record page in the console would
  // be ungated by virtue of not being listed.
  it("resolves a nested detail path to its parent surface", () => {
    expect(routeForPath(`${consolePath("platform.crm")}/11111111-1111-4111-8111-111111111111`))
      .toBe("platform.crm");
  });

  // The rule `isMostSpecificActiveRoute` exists for, applied to access rather
  // than to highlighting: `/platform/secrets/reviews` is guarded by the
  // reviews entry, not by the inventory entry it sits under.
  it("prefers the most specific surface when one nests inside another", () => {
    expect(routeForPath(consolePath("platform.secretsReviews"))).toBe("platform.secretsReviews");
  });

  // Segment boundaries, not string prefixes — the reason `isRouteActive`
  // matches the way it does. `/platform/secretsXYZ` is not inside
  // `/platform/secrets`.
  it("does not match a path that merely shares a string prefix", () => {
    expect(routeForPath(`${consolePath("platform.secrets")}XYZ`)).toBeUndefined();
  });

  it("returns undefined for a path no surface declares", () => {
    expect(routeForPath("/nothing/here")).toBeUndefined();
  });
});

describe("capabilityForPath", () => {
  it("returns the capability the resolved surface declares", () => {
    expect(capabilityForPath(consolePath("platform.crm"))).toBe(routeCapability("platform.crm"));
  });

  it("gives a detail page the same capability as its surface", () => {
    expect(capabilityForPath(`${consolePath("platform.crm")}/abc`))
      .toBe(routeCapability("platform.crm"));
  });

  /**
   * An undeclared path falls back to the ENTRY capability, not to a refusal.
   *
   * Deliberate, and the direction matters. Refusing would make every page
   * that is not a rail entry — a new surface, a nested tool, an error page —
   * 404 for everyone until someone remembers to declare it, which turns this
   * gate into an outage generator and would be discovered in production.
   *
   * The cost is that an undeclared surface is guarded only by console entry.
   * That is exactly today's behaviour for every page, so this cannot make
   * anything less safe than it is now; it makes declared surfaces safer and
   * leaves undeclared ones where they were. `routes.console.test.ts` is what
   * stops a surface going undeclared in the first place.
   */
  it("falls back to console entry for a path no surface declares", () => {
    expect(capabilityForPath("/nothing/here")).toBe("read");
  });
});

import { visibleNav } from "./route-access";
import { platformNav } from "./nav";
import { isNavGroup, type NavEntry } from "./nav";

describe("visibleNav", () => {
  // Real route ids, so the capabilities under test are the ones the console
  // actually declares — `platform.dashboard` is `platform`, `platform.crm` is
  // `crm`, `platform.tickets` is `support`.
  const NAV: readonly NavEntry[] = [
    { name: "Dashboard", route: "platform.dashboard", icon: "layout-dashboard" },
    {
      name: "Growth",
      icon: "users",
      items: [
        { name: "CRM", route: "platform.crm", icon: "users" },
        { name: "Tickets", route: "platform.tickets", icon: "life-buoy" },
      ],
    },
  ];

  it("passes the rail through untouched when enforcement is off", () => {
    // The legacy provider carries no capability claims, so filtering on an
    // absent claim would empty the rail for every operator — the same
    // contract `visibleTo` gives the palette.
    expect(visibleNav(NAV, undefined, false)).toEqual([...NAV]);
  });

  // Fails CLOSED, deliberately: a bug that drops the claims list must not read
  // as full access.
  it("hides everything when enforcement is on and no claims arrived", () => {
    expect(visibleNav(NAV, undefined, true)).toEqual([]);
  });

  it("keeps only the surfaces whose capability the operator holds", () => {
    const visible = visibleNav(NAV, ["crm"], true);
    const names = visible.flatMap((e) => (isNavGroup(e) ? e.items.map((i) => i.name) : [e.name]));
    expect(names).toContain("CRM");
    expect(names).not.toContain("Tickets");
  });

  // A heading with nothing under it reads as a loading failure, not as an
  // absence — the argument `toolsInGroup`'s "leaves no group empty" makes.
  it("drops a group whose every item was filtered away", () => {
    const visible = visibleNav(NAV, ["platform"], true);
    expect(visible.some(isNavGroup)).toBe(false);
  });

  it("does not mutate the rail it was given", () => {
    const before = JSON.stringify(NAV);
    visibleNav(NAV, ["platform"], true);
    expect(JSON.stringify(NAV)).toBe(before);
  });

  // The real rail, not only a fixture: an operator holding every capability
  // must see exactly what they see today, or this filter is a regression
  // dressed as a security control.
  it("leaves the real platform rail whole for an operator holding everything", () => {
    const all = platformNav.flatMap((e) =>
      isNavGroup(e) ? e.items.map((i) => i.route) : [e.route],
    );
    // Array.from, not spread: this package targets ES5, where iterating a Set
    // needs downlevelIteration — the same trap tools.test.ts hit.
    const everyCapability = Array.from(new Set(all.map((route) => routeCapability(route))));

    expect(visibleNav(platformNav, everyCapability, true)).toEqual([...platformNav]);
  });
});
