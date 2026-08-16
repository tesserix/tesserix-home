import { describe, expect, it } from "vitest";
import { webPath, mobilePath, isRouteActive, routeCapability, ROUTE_IDS } from "./routes";

describe("route identity", () => {
  it("prefixes the same id differently per renderer", () => {
    expect(webPath("kora.foods")).toBe("/admin/apps/kora/foods");
    expect(mobilePath("kora.foods")).toBe("/kora/foods");
  });

  it("treats a product root as exact, not prefix", () => {
    // Regression: "/admin/apps/kora" is a strict prefix of every nested Kora
    // route, so a startsWith match kept Overview highlighted everywhere.
    expect(isRouteActive("/admin/apps/kora/foods", "kora.overview", "web")).toBe(false);
    expect(isRouteActive("/admin/apps/kora", "kora.overview", "web")).toBe(true);
  });

  it("matches nested routes by prefix", () => {
    expect(isRouteActive("/admin/apps/kora/foods/abc", "kora.foods", "web")).toBe(true);
  });

  it("does not match a route whose path merely shares a string prefix", () => {
    // Regression: a bare `startsWith(target)` would mark
    // "/admin/apps/kora/foodsXYZ" active for "kora.foods", since
    // "/admin/apps/kora/foods" is a string prefix of it even though it is
    // not a nested route. Matching must respect segment boundaries.
    expect(isRouteActive("/admin/apps/kora/foodsXYZ", "kora.foods", "web")).toBe(false);
  });
});

describe("route capability", () => {
  it("defaults to the console entry ticket", () => {
    // Undeclared routes must resolve to `read`, never `undefined`: a renderer
    // filtering with `heldSet.has(capability)` would drop every one of them.
    expect(routeCapability("platform.dashboard")).toBe("read");
    expect(routeCapability("kora.foods")).toBe("read");
  });

  it("keeps the identity lookup at read, on purpose", () => {
    // #134. Recorded as a decision so it is not read as an omission, and so a
    // later "surely a people-search needs more than read" gets the argument
    // rather than a silent bump: every capability above `read` names a
    // mutation, and the lookup performs none of them. Its accountability comes
    // from an audit row per query, which no capability value can express —
    // this field gates whether the route is OFFERED, not what it logs.
    expect(routeCapability("platform.identityLookup")).toBe("read");
  });

  it("gives every route a capability, declared or defaulted", () => {
    for (const id of ROUTE_IDS) {
      expect(routeCapability(id)).toBeTypeOf("string");
      expect(routeCapability(id)).not.toBe("");
    }
  });

  it("returns the declared capability where a route sets one", () => {
    expect(routeCapability("platform.breakGlass")).toBe("rotate-credentials");
    expect(routeCapability("platform.gdprQueue")).toBe("hard-delete");
    expect(routeCapability("platform.announcements")).toBe("mass-send");
    expect(routeCapability("platform.liveChat")).toBe("respond");
  });

  it("keeps at least one route above the entry ticket", () => {
    // Guards the guard. Every assertion above still passes if a refactor
    // flattens `capability` away and everything falls back to `read` — the
    // exact bug this field was added to fix, where the palette filtered
    // against a constant every operator holds. This is the one test that
    // fails when that happens.
    const elevated = ROUTE_IDS.filter((id) => routeCapability(id) !== "read");
    expect(elevated.length).toBeGreaterThan(0);
  });
});
