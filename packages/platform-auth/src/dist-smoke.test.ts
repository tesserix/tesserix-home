import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// tesserix-home#493: apps/console's vitest.config.ts (#490) aliases
// "@tesserix/platform-auth" to its TypeScript source, on purpose, so the
// console's own unit tests never assert against a stale dist/ (that fix must
// not be undone). But that means a by-name import here
// (`import { hasCapability } from "@tesserix/platform-auth"`) would resolve
// to src/capabilities.ts too, not the tsup output — a test that could never
// fail for the reason it exists. Importing the built file by a literal
// relative path is what forces this test to actually execute what tsup
// produced.
const distIndexPath = new URL("../dist/index.js", import.meta.url);

describe("dist/index.js smoke test", () => {
  it("executes the built artifact, not source", async () => {
    // Fail loudly with an actionable message rather than skip: CI always has
    // a fresh dist/ (build runs before test), so a missing dist/index.js here
    // means a local run skipped the build step, and a silently-skipped test
    // would read green while proving nothing.
    if (!existsSync(distIndexPath)) {
      throw new Error(
        "packages/platform-auth/dist/index.js is missing. Run `pnpm --filter @tesserix/platform-auth build` first.",
      );
    }

    const dist = (await import("../dist/index.js")) as typeof import("./capabilities");

    // hasCapability is the authorization gate every mutating console route
    // is meant to sit behind (see capabilities.ts) — pure, cheap, and the
    // single function a tree-shake/minify bug would most dangerously break
    // silently (an authz check that starts always returning true or false).
    expect(dist.hasCapability(["read"], "read")).toBe(true);
    expect(dist.hasCapability(["read"], "billing")).toBe(false);
    expect(dist.hasCapability(undefined, "read")).toBe(false);
  });
});
