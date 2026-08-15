import { readdirSync, statSync } from "node:fs";
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
 * Counts as of 2026-08-15, when the ratchet was installed.
 *
 * NOTE these are FILE counts, not handler counts. The 51 route files export
 * more handlers than that — several carry GET and PATCH, or GET and PUT — which
 * is why issue #131 says "57 routes" and this says 51. Files are what a ratchet
 * can count without parsing exports, and the distinction is worth keeping
 * straight when comparing the two numbers.
 */
const BASELINE = {
  adminPages: 72,
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
