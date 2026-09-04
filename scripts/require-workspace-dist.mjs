#!/usr/bin/env node
/**
 * Preflight: fail with a sentence when a workspace dependency's `dist/` is
 * missing, before the tool that consumes it gets a chance to misdescribe why.
 *
 * The problem this exists for (#554). `@tesserix/console-core` and
 * `@tesserix/platform-auth` are consumed through their built `dist/`, which is
 * gitignored (`.gitignore` line 96) and produced only by an explicit build. A
 * fresh clone, a `clean` checkout, or a `tsup` run that failed part-way
 * therefore leaves consumers pointed at an artifact that does not exist — and
 * none of the tools involved say so in those words:
 *
 *   - `tsup` emits the JS bundles first and prints "Build success" TWICE
 *     before the DTS step fails, so `pnpm --filter @tesserix/console-core
 *     build` exits 1 under a log whose tail reads green.
 *   - That failed build leaves a JS-only `dist/` behind. `tsc` then resolves
 *     `@tesserix/console-core` through `allowJs` against `dist/index.js`,
 *     which HAS the runtime constants and LACKS every type-only export. The
 *     resulting diagnostics are the worst possible shape — they are confident,
 *     specific, and wrong about the cause:
 *
 *         error TS2724: '"@tesserix/console-core"' has no exported member
 *         named 'RouteId'. Did you mean 'ROUTE_IDS'?
 *
 *     That reads as a consuming-app import mistake, and it names a plausible
 *     replacement, so the obvious next move is to "fix" the import — editing
 *     correct source to match a broken artifact. On a clean checkout of this
 *     branch that produced 21 errors across 12 files, none of which mentioned
 *     `dist` or `platform-auth`.
 *
 * Where this is NOT needed, so the guard is not spread wider than its reason:
 *
 *   - `turbo run <task>` already orders builds correctly — `turbo.json`
 *     declares `dependsOn: ["^build"]` on build, typecheck and test:unit. The
 *     root `pnpm typecheck` has never had this problem.
 *   - `ci.yml` builds `packages/*` explicitly before every per-package step,
 *     and `Dockerfile.console` hardcodes the same ordering with a comment
 *     saying why. CI has never reproduced it either.
 *   - `pnpm --filter console test:unit` is immune for a different reason:
 *     `apps/console/vitest.config.ts` aliases both packages to their `src/`,
 *     so the unit suite never loads `dist` at all. Verified by running it with
 *     `packages/platform-auth/dist` moved aside — 4323 tests passed.
 *
 * What is left is exactly the gap this guard fills: a developer running
 * `pnpm --filter <pkg> typecheck` directly, which is the command this repo's
 * contributors actually use and the only exposed one that resolves types
 * through `dist`.
 *
 * Usage, as a prefix on the consuming package's own script:
 *
 *     "typecheck": "node ../../scripts/require-workspace-dist.mjs && tsc --noEmit"
 *
 * It inspects the package in `process.cwd()`, so it needs no arguments and
 * stays correct if a package is renamed or moved.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WORKSPACE_PROTOCOL = "workspace:";

/**
 * Directories skipped when looking for the newest source mtime. `dist` is the
 * artifact being judged, so walking it would compare it against itself.
 */
const NON_SOURCE_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Every `workspace:`-protocol dependency of `pkg`, in both dependency blocks.
 * devDependencies are included deliberately: `@tesserix/tsconfig` and
 * `@tesserix/eslint-config` live there, and while neither is dist-consumed
 * today, deciding that by looking at each package's own manifest below is more
 * durable than deciding it by which block someone happened to list it in.
 */
function workspaceDependencyNames(pkg) {
  return [
    ...Object.entries(pkg.dependencies ?? {}),
    ...Object.entries(pkg.devDependencies ?? {}),
  ]
    .filter(([, spec]) => typeof spec === "string" && spec.startsWith(WORKSPACE_PROTOCOL))
    .map(([name]) => name);
}

/**
 * Resolve a workspace package name to its directory by reading manifests under
 * the workspace roots, rather than trusting `node_modules/<name>` to be the
 * symlink pnpm usually makes it. Under `node-linker=hoisted` — which `.npmrc`
 * sets — that assumption is not one to build a diagnostic on.
 */
function findWorkspacePackages(repoRoot) {
  const found = new Map();
  for (const dir of ["apps", "packages"]) {
    const root = join(repoRoot, dir);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(root, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        found.set(readJson(manifest).name, join(root, entry.name));
      } catch {
        // A manifest we cannot parse is not this guard's business to report.
      }
    }
  }
  return found;
}

/**
 * The declaration file a consumer's `tsc` will actually resolve — the `types`
 * field, or the `exports["."].types` that supersedes it. A package with
 * neither is not dist-consumed for types and is skipped entirely, which is how
 * `@tesserix/crm-country` (ships `index.mjs`, no build step) and
 * `@tesserix/tsconfig` (JSON only) fall out without needing an allowlist.
 */
function declarationEntry(pkg) {
  return pkg.exports?.["."]?.types ?? pkg.types ?? pkg.typings ?? null;
}

/** Newest mtime under `dir`, skipping generated and vendored trees. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || NON_SOURCE_DIRS.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const { mtimeMs } = statSync(path);
      if (mtimeMs > newest) newest = mtimeMs;
    }
  };
  walk(dir);
  return newest;
}

/** Oldest mtime among the emitted artifacts — the one a partial build strands. */
function oldestMtime(dir) {
  let oldest = Infinity;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const { mtimeMs } = statSync(join(dir, entry.name));
    if (mtimeMs < oldest) oldest = mtimeMs;
  }
  return oldest;
}

const cwd = process.cwd();
const repoRoot = resolve(import.meta.dirname, "..");
const self = readJson(join(cwd, "package.json"));
const workspacePackages = findWorkspacePackages(repoRoot);

const missing = [];
const stale = [];

for (const name of workspaceDependencyNames(self)) {
  const dir = workspacePackages.get(name);
  if (!dir) continue;

  let dependency;
  try {
    dependency = readJson(join(dir, "package.json"));
  } catch {
    continue;
  }

  // Only packages that both emit declarations and have a build to emit them.
  const declaration = declarationEntry(dependency);
  if (!declaration || !dependency.scripts?.build) continue;

  const declarationPath = join(dir, declaration);
  if (!existsSync(declarationPath)) {
    missing.push({ name, declaration });
    continue;
  }

  const src = join(dir, "src");
  if (!existsSync(src)) continue;
  if (newestMtime(src) > oldestMtime(dirname(declarationPath))) stale.push({ name });
}

/**
 * Staleness WARNS where absence FAILS, and the asymmetry is deliberate.
 *
 * A missing declaration file is a fact. There is no reading of the filesystem
 * under which the run that follows can produce a trustworthy answer, and no
 * false positive is possible — so it fails, and the run is not started.
 *
 * Staleness is an INFERENCE from mtimes, and mtimes are not content. A branch
 * switch, a `git checkout` that rewrites a file to the bytes it already had, a
 * rebase, or an editor saving an unmodified buffer all move a source mtime
 * past a `dist` that is still perfectly correct. Failing on that would let a
 * timestamp make a correct tree unrunnable, and "your tests will not run until
 * you rebuild something that did not change" is its own kind of harm — the
 * kind that teaches people to delete the guard. So it prints, names the
 * suspicion, and gets out of the way.
 *
 * The warning is emitted before the tool runs, so it sits at the TOP of the
 * log rather than next to the diagnostics it explains. That is the weak point
 * of warning rather than failing, and it is accepted: the reader who has just
 * been told `RouteId` does not exist scrolls up looking for a cause, and this
 * is what they find when they get there.
 */
if (stale.length > 0) {
  for (const { name } of stale) {
    process.stderr.write(
      `warning: ${name}'s dist/ is older than its src/ — if types or exports look wrong, rebuild: pnpm --filter ${name} build\n`,
    );
  }
}

if (missing.length > 0) {
  for (const { name, declaration } of missing) {
    process.stderr.write(
      `error: ${name} is not built — ${declaration} is missing. Run: pnpm --filter ${name} build\n`,
    );
  }
  process.stderr.write(
    `\nStopping before ${self.name}'s own check runs. Without those declarations TypeScript falls back to the JavaScript bundle and reports missing type-only exports as if this package imported names that never existed (#554).\n`,
  );
  process.exit(1);
}
