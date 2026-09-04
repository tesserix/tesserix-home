import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: every package whose `tsc` resolves a workspace dependency through that
 * dependency's built `dist/` runs `scripts/require-workspace-dist.mjs` first.
 *
 * Without the preflight, an unbuilt or half-built dependency does not produce a
 * diagnostic that names it. It produces confident, specific, WRONG ones in the
 * consuming package — `tsc` falls back to the JavaScript bundle via `allowJs`,
 * sees the runtime constants and none of the type-only exports, and reports
 * `'"@tesserix/console-core"' has no exported member named 'RouteId'. Did you
 * mean 'ROUTE_IDS'?`. That reads as an import mistake in code you can see is
 * correct, and it suggests a replacement, so the natural response is to edit
 * correct source to match a broken artifact (#554).
 *
 * This test is the enforcement mechanism, not the fix. The fix is the prefix on
 * each script; this exists so the NEXT package to acquire a dist-consumed
 * workspace dependency cannot quietly ship without it. It derives the set of
 * packages that need the preflight from the manifests themselves rather than
 * listing them, so a new app or a new dependency edge is covered the moment it
 * exists — the same reasoning as `workspace-typecheck.guard.test.ts`.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const PREFLIGHT = "scripts/require-workspace-dist.mjs";

type Manifest = {
  name?: string;
  types?: string;
  exports?: { ["."]?: { types?: string } };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function workspacePackages(): Map<string, { dir: string; manifest: Manifest }> {
  const found = new Map<string, { dir: string; manifest: Manifest }>();
  for (const group of ["apps", "packages"]) {
    const root = join(REPO_ROOT, group);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "package.json");
      if (!existsSync(path)) continue;
      const manifest = readManifest(path);
      if (manifest.name) found.set(manifest.name, { dir: `${group}/${entry.name}`, manifest });
    }
  }
  return found;
}

/**
 * A dependency is dist-consumed when it both declares a `types` entry point and
 * has a `build` script to produce it. Packages that ship source directly have
 * no artifact that can go missing, which is how `@tesserix/crm-country`
 * (`index.mjs`, no build) and `@tesserix/tsconfig` (JSON only) fall out of the
 * set without needing to be named — an exemption nobody had to write cannot
 * become a stale one.
 */
function isDistConsumed(manifest: Manifest): boolean {
  const types = manifest.exports?.["."]?.types ?? manifest.types;
  return Boolean(types && manifest.scripts?.build);
}

function workspaceDependencies(manifest: Manifest): string[] {
  return [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
  ]
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name);
}

const PACKAGES = workspacePackages();

/** Packages with a `typecheck` script AND at least one dist-consumed workspace dependency. */
const NEEDS_PREFLIGHT = [...PACKAGES.values()]
  .filter(({ manifest }) => typeof manifest.scripts?.typecheck === "string")
  .filter(({ manifest }) =>
    workspaceDependencies(manifest).some((name) => {
      const dependency = PACKAGES.get(name);
      return dependency ? isDistConsumed(dependency.manifest) : false;
    }),
  );

describe("workspace dist preflight", () => {
  it("finds the packages whose typecheck resolves types through a built dist", () => {
    // Not a tautology over the filter above: it asserts the derivation still
    // selects a non-empty set. A refactor that broke `isDistConsumed` would
    // otherwise make every assertion below vacuous and leave the suite green.
    expect(NEEDS_PREFLIGHT.length).toBeGreaterThan(0);
  });

  it.each(NEEDS_PREFLIGHT.map(({ dir, manifest }) => ({ dir, manifest })))(
    "$dir runs the preflight before tsc",
    ({ manifest }) => {
      expect(manifest.scripts?.typecheck).toContain(PREFLIGHT);
    },
  );

  it("ships the preflight script the manifests point at", () => {
    expect(existsSync(join(REPO_ROOT, PREFLIGHT))).toBe(true);
  });

  it("builds console-core behind the preflight too", () => {
    // `@tesserix/console-core`'s own build is the case #554 was filed for: its
    // `tsup` DTS step needs `@tesserix/platform-auth`'s declarations, and when
    // they are absent it prints "Build success" twice — once per JS format —
    // immediately above the failure. The exit code is 1, but a log read from
    // the tail says otherwise, so the preflight has to speak before tsup does.
    expect(PACKAGES.get("@tesserix/console-core")?.manifest.scripts?.build).toContain(PREFLIGHT);
  });
});
