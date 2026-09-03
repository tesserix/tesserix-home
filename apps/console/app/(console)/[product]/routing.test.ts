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

  // Not a statement about fall-through under a static parent: `/[product]` is
  // ONE segment, so it cannot match a two-segment path whatever the precedence
  // rules say. Recorded so a reader does not take it for evidence it is not.
  it("does not match a two-segment path, being a one-segment route", () => {
    expect(resolve("/platform/nope")).toBeNull();
    expect(resolve("/kora/nope")).toBeNull();
  });
});
