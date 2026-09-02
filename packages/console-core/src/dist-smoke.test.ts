import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// tesserix-home#493: every other test in this package imports from "./routes"
// (source), and apps/console's vitest.config.ts (#490) intentionally aliases
// "@tesserix/console-core" to that same source tree — so a by-name import
// here (`import { consolePath } from "@tesserix/console-core"`) would resolve
// straight to src/routes.ts and never touch what `tsup` actually produced.
// That import could never fail for the reason this test exists: a tree-shake,
// minify, or CJS/ESM-interop bug in the build. Importing the built file by a
// literal relative path is what makes this test able to catch that class of
// bug at all.
const distIndexPath = new URL("../dist/index.js", import.meta.url);

describe("dist/index.js smoke test", () => {
  it("executes the built artifact, not source", async () => {
    // A silently skipped/no-op test here would read green while covering
    // nothing, which is worse than no test — so a missing build fails the
    // test loudly with an actionable message instead of skipping.
    if (!existsSync(distIndexPath)) {
      throw new Error(
        "packages/console-core/dist/index.js is missing. Run `pnpm --filter @tesserix/console-core build` first.",
      );
    }

    const dist = (await import("../dist/index.js")) as typeof import("./routes");

    // consolePath + the "kora.overview" ROUTES entry: pure, cheap, and it
    // exercises the `entry.console ?? entry.mobile` fallback branch (this
    // route has no `console` field), so a tree-shaking bug that dropped the
    // fallback or corrupted ROUTES would show up here.
    expect(dist.consolePath("kora.overview")).toBe("/kora");

    // isRouteActive over the same real ROUTES table, exercising the "web"
    // vs "mobile" prefix resolution and the exact-match branch.
    expect(dist.isRouteActive("/admin/apps/kora", "kora.overview", "web")).toBe(true);
    expect(dist.isRouteActive("/admin/apps/kora/foods", "kora.overview", "web")).toBe(false);
  });
});
