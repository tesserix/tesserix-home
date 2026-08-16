import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The admin surface may only shrink.
 *
 * `apps/web`'s admin is being retired: once the console has the features, this
 * app keeps only the marketing site. Every page and API route here is scheduled
 * for deletion or migration.
 *
 * The failure mode this prevents is not a dramatic one. It is a surface that
 * quietly grows while a migration is "in progress" — one more admin page added
 * because it was the fastest place to put it, one more `/api/admin` route
 * because the console does not have that data yet. Each is individually
 * reasonable and collectively the reason the migration never finishes.
 *
 * Issue #103 makes the case for a continuous ratchet over a 55-item milestone
 * with a cliff at the end: "delete the old app at the end" reliably slips,
 * because the residue is always the surfaces nobody wants.
 *
 * ## Raising a number here is not forbidden — it is a conversation
 *
 * If a genuinely new admin capability must land in `apps/web` before the
 * console can host it, raise the baseline in the same commit and say why in
 * the message. The check exists to make that visible, not to block it.
 *
 * Lowering a number is expected and needs nothing: the ratchet tightens on its
 * own the next time someone runs the suite after a deletion.
 */

const WEB_ROOT = join(__dirname, "..");

/**
 * Counts as of 2026-08-15, when the ratchet was installed. `adminPages` was 72
 * then; 69 after #133 moved the ticket queue, the ticket detail and support
 * analytics into apps/console, and 66 since #139 merged the three
 * product-scoped audit pages into the console's one estate-wide timeline.
 *
 * `adminApiRoutes` is unchanged at 51 and that is deliberate rather than
 * incidental: #139 deleted PAGES only. `/api/admin/apps/[product]/audit-logs`
 * is what the console reads server-to-server, so the API layer had to grow a
 * capability while the page surface shrank — which is exactly the boundary #131
 * describes.
 *
 * NOTE these are FILE counts, not handler counts. The 51 route files export
 * more handlers than that — several carry GET and PATCH, or GET and PUT — which
 * is why issue #131 says "57 routes" and this says 51. Files are what a ratchet
 * can count without parsing exports, and the distinction is worth keeping
 * straight when comparing the two numbers.
 */
const BASELINE = {
  adminPages: 66,
  adminApiRoutes: 51,
  internalApiRoutes: 6,
} as const;

function countFiles(dir: string, filename: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // A missing directory means the surface is gone entirely — which is the
    // goal, not an error.
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      total += countFiles(full, filename);
    } else if (entry === filename) {
      total += 1;
    }
  }
  return total;
}

describe("apps/web's admin surface only shrinks", () => {
  it.each([
    ["admin pages", "app/admin", "page.tsx", BASELINE.adminPages],
    ["admin API routes", "app/api/admin", "route.ts", BASELINE.adminApiRoutes],
    [
      "internal API routes",
      "app/api/internal",
      "route.ts",
      BASELINE.internalApiRoutes,
    ],
  ])("%s never exceed the baseline", (label, dir, filename, baseline) => {
    const actual = countFiles(join(WEB_ROOT, dir), filename);
    expect(
      actual,
      `${label} grew from ${baseline} to ${actual}. This surface is being ` +
        `retired — new admin capability belongs in apps/console, which enforces ` +
        `capabilities per route. If it genuinely must land here first, raise ` +
        `the baseline in this file in the same commit and say why.`,
    ).toBeLessThanOrEqual(baseline);
  });

  it("keeps the baseline honest when the surface shrinks", () => {
    // A ratchet that only ever checks "<=" drifts: after ten deletions the
    // baseline still permits ten additions. Fail once the gap is wide enough
    // that the check has stopped meaning anything, so the number gets lowered.
    const SLACK = 5;
    const checks: Array<[string, string, string, number]> = [
      ["admin pages", "app/admin", "page.tsx", BASELINE.adminPages],
      ["admin API routes", "app/api/admin", "route.ts", BASELINE.adminApiRoutes],
      [
        "internal API routes",
        "app/api/internal",
        "route.ts",
        BASELINE.internalApiRoutes,
      ],
    ];
    for (const [label, dir, filename, baseline] of checks) {
      const actual = countFiles(join(WEB_ROOT, dir), filename);
      expect(
        baseline - actual,
        `${label} is now ${actual} but the baseline still says ${baseline}. ` +
          `Lower it to ${actual} so the ratchet keeps its grip.`,
      ).toBeLessThanOrEqual(SLACK);
    }
  });

  it("has given up the surfaces the console now serves", () => {
    // The counts above would also be satisfied by deleting three unrelated
    // pages, so name the three. Re-adding any of them is caught twice: here,
    // and by the baseline, which now sits exactly on the actual count.
    for (const page of [
      "app/admin/platform-tickets/page.tsx",
      "app/admin/platform-tickets/[id]/page.tsx",
      "app/admin/analytics/support/page.tsx",
    ]) {
      expect(
        existsSync(join(WEB_ROOT, page)),
        `${page} is back. It lives in apps/console now (#133); next.config.ts ` +
          `redirects this path there, and a page here would shadow nothing but ` +
          `still rot.`,
      ).toBe(false);
    }
  });

  it("has given up all three product audit pages, not just one", () => {
    // Named individually rather than trusted to the count, and the plural in
    // the title is the point. These three were the SAME capability implemented
    // three times over three different architectures; deleting two and keeping
    // one would satisfy `adminPages <= 66` by deleting something else, and
    // would leave the estate with a console-wide audit log and one product
    // still answering "who did this" somewhere else.
    for (const page of [
      "app/admin/apps/mark8ly/audit-logs/page.tsx",
      "app/admin/apps/kora/audit/page.tsx",
      "app/admin/apps/homechef/audit-logs/page.tsx",
    ]) {
      expect(
        existsSync(join(WEB_ROOT, page)),
        `${page} is back. The console serves /platform/audit-log now (#139), ` +
          `merging every product's trail plus its own; next.config.ts redirects ` +
          `this path there with the product preselected.`,
      ).toBe(false);
    }
  });

  it("keeps the audit API route the console reads", () => {
    // The counterweight to the deletions above. #139 retired the PAGES and
    // deliberately kept the API layer: apps/console calls
    // /api/admin/apps/[product]/audit-logs server-to-server, so deleting it as
    // "more of the same cleanup" would take the replacement surface down with
    // the surfaces it replaced. This is why adminApiRoutes stays at 51.
    expect(
      existsSync(
        join(WEB_ROOT, "app/api/admin/apps/[product]/audit-logs/route.ts"),
      ),
    ).toBe(true);
  });

  it("still serves live chat", () => {
    // #197 owns /admin/support/live-chat and has not landed. It was left out of
    // the #133 sweep on purpose; deleting it takes a working surface offline
    // with nowhere to redirect to.
    expect(existsSync(join(WEB_ROOT, "app/admin/support/live-chat/page.tsx"))).toBe(
      true,
    );
  });

  it("is actually looking at files, not an empty directory", () => {
    // Guards the guard. If the walk silently stopped matching — a moved
    // directory, a renamed convention — every assertion above would pass by
    // counting zero.
    expect(countFiles(join(WEB_ROOT, "app/admin"), "page.tsx")).toBeGreaterThan(
      50,
    );
    expect(
      countFiles(join(WEB_ROOT, "app/api/admin"), "route.ts"),
    ).toBeGreaterThan(40);
  });
});
