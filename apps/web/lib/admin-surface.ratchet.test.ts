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
 * analytics into apps/console, 66 after #139 merged the three product-scoped
 * audit pages into the console's one estate-wide timeline — and 72 again now.
 *
 * ## The baseline went UP, deliberately, by decision
 *
 * Per the header above, raising a number here is "the conversation" rather than
 * a violation, so here is that conversation on the record.
 *
 * All six pages are restored and their redirects removed. The ruling is that
 * NOTHING under /admin/ is retired or changed until the console app is
 * complete — #133 and #139 retired these ahead of that, and the console's
 * surfaces are good but not yet the whole story. The console keeps every
 * surface it gained; both systems now run side by side over the same API.
 *
 * This is a one-off correction to a premature deletion, not a new admin
 * capability and not a licence for more. 72 is the number the ratchet started
 * at — the surface has not grown past where it began, and it may only shrink
 * from here.
 *
 * `adminApiRoutes` is unchanged at 51 through all of it: #133 and #139 deleted
 * PAGES only, and so does this restore. `/api/admin/apps/[product]/audit-logs`
 * is what BOTH the console and the restored mark8ly page read — one route, two
 * shapes, chosen by the caller.
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

  it("still serves the support surfaces the console also serves", () => {
    // These three asserted their own ABSENCE until the restore. The count
    // above would be satisfied by any six pages, so name the six: a repeat of
    // the premature retirement would pass `adminPages <= 72` by deleting
    // something else and fail here, which is the whole point of naming them.
    for (const page of [
      "app/admin/platform-tickets/page.tsx",
      "app/admin/platform-tickets/[id]/page.tsx",
      "app/admin/analytics/support/page.tsx",
    ]) {
      expect(
        existsSync(join(WEB_ROOT, page)),
        `${page} is gone. It was retired by #133 and restored by decision: ` +
          `nothing under /admin/ is retired until the console app is complete. ` +
          `The console's own support surface is unaffected either way.`,
      ).toBe(true);
    }
  });

  it("still serves all three product audit pages, not just one", () => {
    // The plural is still the point, with the sign flipped. These three are
    // the same capability over three different architectures, and losing any
    // one of them leaves a product whose "who did this" is answered only by a
    // console that is not finished yet.
    for (const page of [
      "app/admin/apps/mark8ly/audit-logs/page.tsx",
      "app/admin/apps/kora/audit/page.tsx",
      "app/admin/apps/homechef/audit-logs/page.tsx",
    ]) {
      expect(
        existsSync(join(WEB_ROOT, page)),
        `${page} is gone. It was retired by #139 and restored by decision. ` +
          `The console's merged /platform/audit-log keeps working alongside it ` +
          `— both read /api/admin/apps/[product]/audit-logs.`,
      ).toBe(true);
    }
  });

  it("keeps the audit API route the console reads", () => {
    // The one thing #139 kept and this restore also keeps. apps/console calls
    // /api/admin/apps/[product]/audit-logs server-to-server for its merged
    // `entries`, and the restored mark8ly page calls the same route for its
    // `rows`. Deleting it now takes BOTH surfaces down. This is why
    // adminApiRoutes stays at 51 across the retirement and the restore alike.
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
