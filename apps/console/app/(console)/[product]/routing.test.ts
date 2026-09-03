import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sortPages } from "next/dist/shared/lib/router/utils/sortable-routes";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";

/**
 * What `[product]` actually matches, measured rather than asserted.
 *
 * # Why this test exists at all
 *
 * `app/(console)/[product]/page.tsx` is the console's first top-level dynamic
 * segment. `/platform/*` and `/kora/*` are static and must keep winning over
 * it, and I did not want a comment claiming Next's precedence rules from
 * memory — this repo has a documented habit of comments that state a
 * mechanism nobody checked.
 *
 * # What this exercises, and what it does not
 *
 * It runs NEXT'S OWN modules — `sortPages` (the specificity sort that puts
 * static segments ahead of dynamic ones) and `getRouteRegex`/`getRouteMatcher`
 * (the matcher) — over the page list discovered from `app/` on disk. First
 * match in sorted order wins, which is the precedence model those modules
 * exist to express.
 *
 * It is NOT a running server. No layout runs, no middleware, no interception
 * or parallel routes, and the `app-paths-manifest` a real build emits is not
 * consulted. It is evidence about Next's route precedence code, not proof
 * about a request. A rewrite in `next.config.ts` or `middleware.ts` could
 * still redirect any of these paths before routing sees them.
 *
 * # The negative control
 *
 * `resolves /platform to the dynamic segment` is the row that fails if the
 * dynamic page is deleted: today it resolves to `/[product]`, and without the
 * file it resolves to nothing. It is also the row that documents the hazard —
 * `/platform` has no `page.tsx` of its own, so this file gave a previously
 * unmatched path a match, and only `resolveProductParam` stops it rendering a
 * product overview for the platform rail.
 */

const APP_ROOT = path.resolve(__dirname, "../../../app");

/**
 * Every routable page path under `app/`, in Next's own notation.
 *
 * Route groups — `(console)` — contribute no URL segment, which is the whole
 * reason `/kora` and `/[product]` are siblings at the URL root despite sitting
 * inside one.
 */
function discoverPages(dir: string, segments: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      const isRouteGroup = entry.startsWith("(") && entry.endsWith(")");
      found.push(...discoverPages(full, isRouteGroup ? segments : [...segments, entry]));
    } else if (entry === "page.tsx" || entry === "page.ts") {
      found.push(segments.length === 0 ? "/" : `/${segments.join("/")}`);
    }
  }
  return found;
}

const PAGES = sortPages(discoverPages(APP_ROOT));

/** The page file a pathname resolves to, or `null` when nothing matches. */
function resolve(pathname: string): { page: string; params: Record<string, unknown> } | null {
  for (const page of PAGES) {
    const matched = getRouteMatcher(getRouteRegex(page))(pathname);
    if (matched !== false) return { page, params: matched };
  }
  return null;
}

describe("the [product] segment against Next's own route precedence", () => {
  it("discovers the dynamic page and the static rails it must not swallow", () => {
    // If this fails, every other row below is measuring the wrong file set.
    expect(PAGES).toContain("/[product]");
    expect(PAGES).toContain("/kora");
    expect(PAGES).toContain("/platform/inbox");
  });

  it("keeps /kora on Kora's bespoke page, not the generic one", () => {
    expect(resolve("/kora")?.page).toBe("/kora");
  });

  it("keeps a static child of a static parent on its own page", () => {
    expect(resolve("/platform/inbox")?.page).toBe("/platform/inbox");
  });

  it("resolves /mark8ly to the dynamic segment", () => {
    expect(resolve("/mark8ly")).toEqual({ page: "/[product]", params: { product: "mark8ly" } });
  });

  // THE NEGATIVE CONTROL, and the hazard this task had to find out about
  // rather than guess. `/platform` has no page of its own; before this task it
  // matched nothing. It now matches `/[product]`, so the registry check in
  // `resolveProductParam` is the only thing between it and a rendered product
  // overview. Delete `[product]/page.tsx` and this row goes red.
  it("resolves /platform to the dynamic segment, which is why the registry check exists", () => {
    expect(resolve("/platform")).toEqual({ page: "/[product]", params: { product: "platform" } });
  });

});

/**
 * The two-segment half, added when `[product]/[entity]/page.tsx` landed.
 *
 * Task 4 recorded that `/platform/nope` and `/kora/nope` matched NOTHING, and
 * was explicit that this was a segment-count fact — `/[product]` is one
 * segment — rather than evidence about fall-through. Adding a two-segment
 * dynamic route is what puts the question to the test, and it turns out the
 * same way `/platform` did: paths that previously produced the framework 404
 * now match, and the param checks are the only thing refusing them.
 *
 * Same methodology and same limits as above: Next's own sorter and matcher
 * over the on-disk page list, not a running server.
 */
describe("the [product]/[entity] segment against Next's own route precedence", () => {
  it("discovers the two-segment dynamic page and the static children it must not swallow", () => {
    // If this fails, every other row below is measuring the wrong file set.
    expect(PAGES).toContain("/[product]/[entity]");
    expect(PAGES).toContain("/kora/foods");
    expect(PAGES).toContain("/kora/users");
    expect(PAGES).toContain("/platform/tenants");
  });

  it("keeps Kora's own index pages on their bespoke files", () => {
    // Kora's food index renders an expandable detail row the generic page has
    // no equivalent for, so these winning is load-bearing, not cosmetic.
    expect(resolve("/kora/foods")?.page).toBe("/kora/foods");
    expect(resolve("/kora/users")?.page).toBe("/kora/users");
  });

  it("keeps /platform/tenants on the platform rail's own page", () => {
    // Same word as `mark8ly.tenants`, different surface — the estate-wide
    // directory. A dynamic route swallowing it would show one product's rows
    // under the estate's heading.
    expect(resolve("/platform/tenants")?.page).toBe("/platform/tenants");
  });

  it("resolves /mark8ly/tenants and /mark8ly/users to the generic entity page", () => {
    expect(resolve("/mark8ly/tenants")).toEqual({
      page: "/[product]/[entity]",
      params: { product: "mark8ly", entity: "tenants" },
    });
    expect(resolve("/mark8ly/users")).toEqual({
      page: "/[product]/[entity]",
      params: { product: "mark8ly", entity: "users" },
    });
  });

  // THE BEHAVIOUR CHANGE. Both of these matched nothing before this page
  // existed and produced the framework 404; they now reach a rendered segment
  // and produce the console's `not-found.tsx` instead. Recorded here because
  // it is a change to previously-404ing URLs, and because it is exactly why
  // `resolveEntitySurface` refuses both — `platform` is not a product, and
  // `nope` is not one of Kora's declared types.
  it("gives a previously-unmatched two-segment path a match, which the param checks then refuse", () => {
    expect(resolve("/platform/nope")).toEqual({
      page: "/[product]/[entity]",
      params: { product: "platform", entity: "nope" },
    });
    expect(resolve("/kora/nope")).toEqual({
      page: "/[product]/[entity]",
      params: { product: "kora", entity: "nope" },
    });
  });

  // The negative control for this block: `/[product]/[entity]` is TWO
  // segments, so it cannot match a three-segment path. Without a row like this
  // the ones above would be consistent with a route that matched everything.
  it("does not match a three-segment path, being a two-segment route", () => {
    expect(resolve("/mark8ly/tenants/some-tenant-id")).toBeNull();
  });
});
