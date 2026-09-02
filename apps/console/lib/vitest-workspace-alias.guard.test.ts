import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: `vitest.config.ts` keeps aliasing the built workspace packages to
 * their TypeScript sources.
 *
 * What breaks if an alias is removed: `@tesserix/console-core` and
 * `@tesserix/platform-auth` resolve through their `main`/`module` to a
 * gitignored `dist/`, rebuilt only by an explicit
 * `pnpm -r --filter "./packages/**" build`. Drop the alias and this whole
 * console suite silently starts asserting against that build artifact instead
 * of the source in the same repo — so it keeps passing while `src` and the
 * thing under test drift apart, and starts failing on whatever was added since
 * the artifact was last written.
 *
 * That failure is very hard to read. It is not a build error: the bundle loads,
 * it is simply missing an export or a map entry, so it surfaces as an
 * `undefined` lookup deep inside working code. And tsup ships source maps, so
 * the stack frame points back into each package's own `src` — source that is
 * demonstrably correct. It also looks intermittent, because `dist` freshness
 * varies per worktree, and CI never reproduces it at all: `ci.yml` builds the
 * packages first, so a PR is green while every local run is red.
 *
 * The property is about vitest's own resolution, so no test running under
 * vitest can observe it from the inside — a test that imports the package gets
 * whichever copy the config chose and cannot tell which that was. Hence
 * reading the config text, in the spirit of the other guards in this directory.
 */

const CONSOLE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(CONSOLE_ROOT, "..", "..");

/**
 * The workspace packages whose `package.json` points at a build output. Both
 * must be aliased. `@tesserix/web` is deliberately absent — it is a genuine
 * published dependency rather than workspace source, and `server.deps.inline`
 * is what it needs; so is `@tesserix/crm-country`, which ships `index.mjs`
 * directly and has no build artifact to go stale.
 */
const ALIASED_PACKAGES = [
  { specifier: "@tesserix/console-core", dir: "packages/console-core" },
  { specifier: "@tesserix/platform-auth", dir: "packages/platform-auth" },
] as const;

const config = readFileSync(join(CONSOLE_ROOT, "vitest.config.ts"), "utf8");

describe("vitest resolves workspace packages to source, not dist", () => {
  it.each(ALIASED_PACKAGES)("$specifier is aliased to its src entrypoint", ({ specifier, dir }) => {
    // One line, matched end to end: the specifier as a key, then — anywhere
    // before the newline, so the `join(import.meta.dirname, …)` comma is not a
    // boundary — that package's `src/index.ts`.
    const alias = new RegExp(`"${specifier}":[^\\n]*${dir}/src/index\\.ts`);
    expect(
      config,
      `apps/console/vitest.config.ts no longer aliases ${specifier} to ${dir}/src/index.ts. Without it the console suite resolves the package's gitignored dist/ build and silently tests a stale artifact instead of the source.`,
    ).toMatch(alias);
  });

  it.each(ALIASED_PACKAGES)("$specifier's src entrypoint exists", ({ dir }) => {
    expect(existsSync(join(REPO_ROOT, dir, "src/index.ts"))).toBe(true);
  });

  /**
   * Both vitest projects declare their own `resolve.alias`, so an alias added
   * to only one of them leaves the other resolving `dist`. Node runs the
   * `*.test.ts` half of this suite and dom the `*.test.tsx` half; either half
   * on a stale artifact is the full defect.
   */
  it("applies the alias to both the node and dom projects", () => {
    const merges = config.match(/\.\.\.WORKSPACE_SRC_ALIAS/g) ?? [];
    expect(
      merges.length,
      "WORKSPACE_SRC_ALIAS must be merged into the resolve.alias of both vitest projects (node and dom); one of them is resolving the built dist instead.",
    ).toBe(2);
  });
});
