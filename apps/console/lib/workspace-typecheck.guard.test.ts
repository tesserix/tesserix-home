import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: every workspace package holding TypeScript source declares a
 * `typecheck` script.
 *
 * CI does not run `turbo run typecheck` — `.github/workflows/ci.yml` invokes
 * `pnpm --filter <target> <script>` per target. `pnpm --filter` SKIPS a package
 * that has no such script, silently and with exit code 0, so a package that
 * ships without a `typecheck` script is not type-checked and nothing anywhere
 * says so. That is how `@tesserix/crm-country` reached main untyped-checked
 * (#231); adding the CI step fixes that instance but leaves the mechanism
 * intact for the next package.
 *
 * This test is the enforcement mechanism. It reads `pnpm-workspace.yaml` rather
 * than a hardcoded package list, so a package added under a new workspace
 * directory is covered the moment it exists. The two script-less packages are
 * named in ALLOWLIST below with the reason each is exempt — an exclusion has to
 * be a deliberate edit here, never something inherited by omission.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");

/**
 * Packages deliberately exempt: they contain no TypeScript source at all, so
 * `tsc --noEmit` would have nothing to check. Adding an entry means asserting
 * that — the test below proves each one really is TypeScript-free, so an entry
 * that stops being true fails rather than quietly widening the exemption.
 */
const ALLOWLIST: Record<string, string> = {
  // Shared `tsconfig` bases. JSON only — `base.json` plus a `package.json`.
  "packages/tsconfig": "JSON config only, no TypeScript source",
  // Flat ESLint config. `.mjs` only; it carries a `lint` script and no `.ts`.
  "packages/eslint-config": ".mjs config only, no TypeScript source",
};

/**
 * Directories whose `.ts`/`.d.ts` files are generated or vendored, never source
 * a `tsc --noEmit` run would be pointed at. `dist/` matters most here: every
 * built package emits `.d.ts` there, so walking it would make a source-free
 * package look like it has TypeScript.
 */
const NON_SOURCE_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  ".expo",
  "coverage",
  "build",
]);

/**
 * Minimal reader for the `packages:` list in `pnpm-workspace.yaml`. Hand-parsed
 * rather than imported from a YAML library because no YAML parser is a declared
 * dependency of this app, and adding one to read six lines is not a trade worth
 * making. Anything beyond a flat list of quoted `dir/*` entries throws — see
 * expandPackagePattern.
 */
function readWorkspacePatterns(yamlText: string): string[] {
  const section = yamlText.match(/^packages:\s*$([\s\S]*?)(?=^\S|\s*$(?![\s\S]))/m);
  if (!section) {
    throw new Error("pnpm-workspace.yaml: no `packages:` section found");
  }
  const patterns = [...section[1].matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?\s*$/gm)].map(
    (match) => match[1],
  );
  if (patterns.length === 0) {
    throw new Error("pnpm-workspace.yaml: `packages:` section lists no patterns");
  }
  return patterns;
}

/** Every directory the pattern matches that actually holds a package.json. */
function expandPackagePattern(pattern: string): string[] {
  const parent = pattern.match(/^([\w.\-/]+)\/\*$/)?.[1];
  if (!parent) {
    // Fail loudly rather than skip: an unsupported pattern would otherwise
    // shrink the guard's scope invisibly, which is the exact defect above.
    throw new Error(
      `pnpm-workspace.yaml: unsupported pattern "${pattern}" — this guard understands only "<dir>/*". Extend expandPackagePattern.`,
    );
  }
  const parentPath = join(REPO_ROOT, parent);
  if (!existsSync(parentPath)) {
    throw new Error(`pnpm-workspace.yaml: pattern "${pattern}" points at a missing directory`);
  }
  return readdirSync(parentPath)
    .map((entry) => `${parent}/${entry}`)
    .filter((rel) => existsSync(join(REPO_ROOT, rel, "package.json")));
}

/**
 * "Contains TypeScript source" = at least one `.ts`/`.tsx`/`.mts`/`.cts` file
 * outside NON_SOURCE_DIRS. File extension, not `package.json` fields: a package
 * can carry TypeScript that its scripts never mention, and that is precisely
 * the case the guard has to catch.
 */
function hasTypeScriptSource(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    if (NON_SOURCE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (hasTypeScriptSource(full)) return true;
    } else if (/\.(m|c)?tsx?$/.test(entry)) {
      return true;
    }
  }
  return false;
}

function readScripts(rel: string): Record<string, string> {
  const manifest = readFileSync(join(REPO_ROOT, rel, "package.json"), "utf8");
  return (JSON.parse(manifest) as { scripts?: Record<string, string> }).scripts ?? {};
}

const workspacePatterns = readWorkspacePatterns(
  readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"),
);
const packageDirs = workspacePatterns.flatMap(expandPackagePattern).sort();

describe("every workspace package with TypeScript source has a typecheck script", () => {
  // Vacuity check. If pattern parsing or expansion silently returned nothing,
  // every it.each below would vanish and the suite would pass while enforcing
  // nothing — the same shape of non-failing check this guard exists to prevent.
  it("discovers the workspace packages", () => {
    expect(packageDirs.length).toBeGreaterThan(Object.keys(ALLOWLIST).length);
  });

  it.each(packageDirs)("%s", (rel) => {
    const scripts = readScripts(rel);
    const exemptReason = ALLOWLIST[rel];

    if (exemptReason) {
      // An allowlisted package that grows TypeScript is no longer exempt: drop
      // it from ALLOWLIST and give it a `typecheck` script.
      expect(
        hasTypeScriptSource(join(REPO_ROOT, rel)),
        `${rel} is allowlisted as "${exemptReason}" but now contains TypeScript source — remove it from ALLOWLIST in this test and add a "typecheck" script to its package.json.`,
      ).toBe(false);
      return;
    }

    if (!hasTypeScriptSource(join(REPO_ROOT, rel))) return;

    expect(
      scripts.typecheck,
      `${rel} contains TypeScript source but declares no "typecheck" script. \`pnpm --filter\` skips missing scripts silently, so CI would report success without type-checking it. Add "typecheck": "tsc --noEmit" to ${rel}/package.json, or — if it genuinely has no TypeScript to check — add it to ALLOWLIST in this test with the reason.`,
    ).toBeDefined();
  });
});
