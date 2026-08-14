import { describe, expect, it } from "vitest";
import { webPath, mobilePath, isRouteActive } from "./routes";

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
