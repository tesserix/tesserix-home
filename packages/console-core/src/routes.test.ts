import { describe, expect, it } from "vitest";
import { webPath, mobilePath, isRouteActive, routeCapability, ROUTE_IDS, ROUTES } from "./routes";

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

  it("is never active for a renderer the route has no path for", () => {
    // "platform.tools" has no `mobile` path at all (see RouteEntry.mobile) —
    // without a guard, `target` is `undefined` and the string-prefix checks
    // fall through to comparing against the literal "undefined/", which can
    // spuriously match. The honest answer for "no path to be active against"
    // is `false`, not a string match on the word "undefined".
    expect(isRouteActive("/platform/tools", "platform.tools", "mobile")).toBe(false);
    // Same trap on the `web` prefix — "platform.tools" has no `web` path
    // either, and this path was already reachable before `mobile` became
    // optional (`web` always was), so it is equally worth pinning here.
    expect(isRouteActive("/platform/tools", "platform.tools", "web")).toBe(false);
  });

  it("does not match a path that collides with the string an absent target stringifies to", () => {
    // Deliberately absurd input, and that is the point: `platform.tools` has no
    // `mobile` or `web` path, so without the undefined guard `target`
    // stringifies into the template as "undefined/" and ANY path under a
    // literal "undefined/" prefix would match. A tidier currentPath cannot
    // tell the guarded and unguarded versions apart — both answer `false` for
    // it — so a test built on one would pass against the very bug it exists
    // to catch. This is the ablation that actually distinguishes them.
    expect(isRouteActive("undefined/anything", "platform.tools", "mobile")).toBe(false);
    expect(isRouteActive("undefined/anything", "platform.tools", "web")).toBe(false);
  });
});

describe("route capability", () => {
  it("has no default — every route names its own capability", () => {
    // #261 removed the `read` default. It was doing the opposite of its stated
    // job: 26 of 30 routes declared nothing, so "unspecified" quietly meant
    // "anyone who can reach the console". A default that is also the weakest
    // capability in the system is an opt-out nobody has to take deliberately.
    //
    // The type makes this unskippable, so what is left to assert is that no
    // route resolves to the entry ticket by accident.
    expect(routeCapability("platform.dashboard")).toBe("platform");
    expect(routeCapability("kora.foods")).toBe("platform");
  });

  it("puts no route on the console entry ticket", () => {
    // The property #261 exists for, stated as an invariant rather than a list:
    // `read` means "may enter the console" and nothing else, so a route
    // resolving to it would be a surface gated on the ticket every operator
    // already holds.
    const onEntry = ROUTE_IDS.filter((id) => routeCapability(id) === "read");

    expect(onEntry).toEqual([]);
  });

  it("gives the identity lookup a surface, now that one exists", () => {
    // #134 recorded this staying at `read` because none of the seven
    // capabilities described "may look people up" — every one above `read`
    // named a MUTATION, and borrowing one would have implied the surface could
    // do the thing that capability names.
    //
    // #261 answers it: `platform` is a SURFACE, not a verb, so it says where
    // the lookup lives without claiming it deletes anything. The original
    // reasoning is honoured rather than overridden — it was waiting for a
    // capability of this shape to exist.
    expect(routeCapability("platform.identityLookup")).toBe("platform");
  });

  it("gives every route a capability", () => {
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

  it("declares the tools surface on the console only, gated on platform", () => {
    const route = ROUTES["platform.tools"];
    expect(route.console).toBe("/platform/tools");
    expect(route.capability).toBe("platform");
    // Deliberately console-only: apps/web has no directory management and is
    // being retired. A `web` path here would put a link in a rail that leads
    // nowhere.
    expect(route.web).toBeUndefined();
  });
});
