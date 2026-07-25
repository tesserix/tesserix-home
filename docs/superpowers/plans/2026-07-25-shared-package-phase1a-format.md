# Shared Package Phase 1a — `@tesserix/homechef-shared` + `format.ts` De-dup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the byte-identical `format.ts` from `apps/web` and `apps/mobile` into a new shared workspace package `@tesserix/homechef-shared`, proving the shared-package build/consumption pipeline works for BOTH Next.js (Turbopack) and Expo (Metro).

**Architecture:** A pure-TypeScript package built with `tsup` (cjs+esm+dts, mirroring the design-system's `@tesserix/web`). Both apps depend on it via `workspace:*` and import the built `dist`. This is deliberately the smallest, zero-drift slice (`format.ts` is identical in both apps) so the risky part — Metro resolving a workspace package — is proven in isolation before the harder `contracts.ts` reconciliation (a separate follow-up plan).

**Tech Stack:** pnpm 10.17.1, Turborepo, tsup, Vitest, Next.js 16, Expo/Metro.

## Global Constraints

- **No behavior change.** The `format.ts` functions are byte-identical across both apps today (verified with `diff`); the extracted package must export the exact same functions with identical behavior.
- **Package manager:** pnpm `10.17.1`; `.npmrc` already has `node-linker=hoisted` (required for Metro).
- **Build tool:** `tsup`, config mirroring `design-system/packages/web/tsup.config.ts` (`format: ["cjs","esm"], dts: true, sourcemap: true, clean: true, treeshake: true, splitting: false, minify: false`).
- **Package name:** `@tesserix/homechef-shared` (will also hold `contracts.ts` / an http-port in later phases — see the sketch).
- **Public API (must stay identical):** `formatINR`, `formatCount`, `formatDateTime`, `formatDate`, `titleCase`, `formatRelative`.
- **Consumption:** both apps import from `@tesserix/homechef-shared` (the built `dist`), NOT raw source. No `transpilePackages` entry needed for Next (it consumes `dist`).
- **Verification gates:** `pnpm --filter web build` + `typecheck` + `test:unit`; `pnpm --filter mobile typecheck` + a Metro bundle smoke; `pnpm --filter @tesserix/homechef-shared test` (Vitest); `turbo run build` green.
- **Types on public APIs** (coding-style): every exported function keeps explicit param + return types (the source already has them).
- **No `console.log`; no `any`.**

**Recommended:** execute on a `feat/shared-format` branch. Branch pushes no longer auto-deploy (the CI guard is on `main`), so this is safe.

## File Structure

```
packages/homechef-shared/            ← NEW pure-TS package
├── package.json                     @tesserix/homechef-shared, tsup build
├── tsconfig.json                    extends @tesserix/tsconfig/base.json
├── tsup.config.ts
├── src/
│   ├── index.ts                     re-exports ./format
│   ├── format.ts                    the 6 formatters (verbatim move)
│   └── format.test.ts               Vitest unit tests (new)
apps/web/
├── package.json                     + "@tesserix/homechef-shared": "workspace:*"
├── lib/products/homechef/format.ts  ← DELETED (22 import sites repointed)
apps/mobile/
├── package.json                     + "@tesserix/homechef-shared": "workspace:*"
├── metro.config.ts                  ← NEW (monorepo Metro resolution)
├── lib/format.ts                    ← DELETED (6 import sites repointed)
```

---

### Task 1: Scaffold the `@tesserix/homechef-shared` package

Create the package skeleton with a `tsup` build and confirm it builds an (empty) `dist`.

**Files:**
- Create: `packages/homechef-shared/package.json`
- Create: `packages/homechef-shared/tsconfig.json`
- Create: `packages/homechef-shared/tsup.config.ts`
- Create: `packages/homechef-shared/src/index.ts`

**Interfaces:**
- Produces: workspace package `@tesserix/homechef-shared` with scripts `build` (tsup), `typecheck`, `test`; outputs `dist/index.js` (cjs), `dist/index.mjs` (esm), `dist/index.d.ts`.

- [ ] **Step 1: Create `packages/homechef-shared/package.json`**

```json
{
  "name": "@tesserix/homechef-shared",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "sideEffects": false,
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@tesserix/tsconfig": "workspace:*",
    "tsup": "^8.5.0",
    "typescript": "5.9.3",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Create `packages/homechef-shared/tsconfig.json`**

```json
{
  "extends": "@tesserix/tsconfig/base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["ES2020"],
    "types": [],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/homechef-shared/tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
});
```

- [ ] **Step 4: Create a placeholder `packages/homechef-shared/src/index.ts`**

```ts
export {};
```

- [ ] **Step 5: Install and build**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
pnpm install
pnpm --filter @tesserix/homechef-shared build
ls packages/homechef-shared/dist
```
Expected: `pnpm install` links the new package; build succeeds; `dist/` contains `index.js`, `index.mjs`, `index.d.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/homechef-shared pnpm-lock.yaml
git commit -m "chore: scaffold @tesserix/homechef-shared package (tsup)"
```

---

### Task 2: Move `format` into the package with tests

Add the six formatters (verbatim) and Vitest coverage, then build.

**Files:**
- Create: `packages/homechef-shared/src/format.ts`
- Create: `packages/homechef-shared/src/format.test.ts`
- Modify: `packages/homechef-shared/src/index.ts`

**Interfaces:**
- Produces: `@tesserix/homechef-shared` exports `formatINR`, `formatCount`, `formatDateTime`, `formatDate`, `titleCase`, `formatRelative` — signatures `(value: number | string | Date | null | undefined) => string` (see exact source below).

- [ ] **Step 1: Write the failing test** — `packages/homechef-shared/src/format.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatINR,
  formatRelative,
  titleCase,
} from "./format";

describe("formatINR", () => {
  it("formats Indian-grouped rupees", () => {
    expect(formatINR(123456)).toBe("₹1,23,456");
  });
  it("falls back to 0 for null/undefined/NaN", () => {
    expect(formatINR(null)).toBe("₹0");
    expect(formatINR(undefined)).toBe("₹0");
    expect(formatINR(Number.NaN)).toBe("₹0");
  });
});

describe("formatCount", () => {
  it("groups with en-IN and zero-falls-back", () => {
    expect(formatCount(1234567)).toBe("12,34,567");
    expect(formatCount(null)).toBe("0");
  });
});

describe("formatDateTime / formatDate", () => {
  it("returns em dash for empty/invalid", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });
  it("formats a real date without throwing", () => {
    expect(formatDate("2026-01-15T10:00:00Z")).toContain("2026");
  });
});

describe("titleCase", () => {
  it("converts snake/kebab to Title Case", () => {
    expect(titleCase("payout_setup")).toBe("Payout Setup");
    expect(titleCase("delivery-failures")).toBe("Delivery Failures");
    expect(titleCase(null)).toBe("");
  });
});

describe("formatRelative", () => {
  it("says just now for very recent times", () => {
    expect(formatRelative(new Date(Date.now() - 5 * 1000))).toBe("just now");
  });
  it("reports minutes and hours ago", () => {
    expect(formatRelative(new Date(Date.now() - 5 * 60 * 1000))).toBe("5m ago");
    expect(formatRelative(new Date(Date.now() - 3 * 60 * 60 * 1000))).toBe("3h ago");
  });
  it("returns em dash for empty", () => {
    expect(formatRelative(null)).toBe("—");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @tesserix/homechef-shared test
```
Expected: FAIL — cannot resolve `./format` (module not created yet).

- [ ] **Step 3: Create `packages/homechef-shared/src/format.ts`** (verbatim from the existing identical file)

```ts
// Small formatting helpers shared across the HomeChef admin pages.

/** ₹1,23,456 — Indian-grouped rupees (HomeChef bills in INR). */
export function formatINR(amount: number | null | undefined): string {
  const n = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function formatCount(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return v.toLocaleString("en-IN");
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { dateStyle: "medium" });
}

/** snake_case / kebab-case → "Title Case" */
export function titleCase(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "3h ago" / "just now" — relative time for activity feeds. */
export function formatRelative(value: string | number | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
}
```

- [ ] **Step 4: Re-export from `packages/homechef-shared/src/index.ts`**

```ts
export * from "./format";
```

- [ ] **Step 5: Run tests + build to verify pass**

Run:
```bash
pnpm --filter @tesserix/homechef-shared test
pnpm --filter @tesserix/homechef-shared build
```
Expected: all tests PASS (pristine output); build emits `dist/index.{js,mjs,d.ts}` exporting the six functions.

- [ ] **Step 6: Commit**

```bash
git add packages/homechef-shared/src
git commit -m "feat(homechef-shared): add format helpers with tests"
```

---

### Task 3: Repoint `apps/web` to the shared package and delete its local `format.ts`

**Files:**
- Modify: `apps/web/package.json` (add workspace dep)
- Modify: the 22 web files importing `homechef/format` (repoint import)
- Delete: `apps/web/lib/products/homechef/format.ts`

**Interfaces:**
- Consumes: `@tesserix/homechef-shared` (the six formatters).

- [ ] **Step 1: Add the workspace dependency to `apps/web/package.json`**

Add to `dependencies` (keep all existing):
```json
    "@tesserix/homechef-shared": "workspace:*"
```

- [ ] **Step 2: Repoint every web import of the local format module**

Run (repoints the alias import and any relative imports to the package):
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
# alias imports: @/lib/products/homechef/format
grep -rl "products/homechef/format" apps/web --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' -E "s#['\"][^'\"]*products/homechef/format['\"]#\"@tesserix/homechef-shared\"#g"
# confirm none remain
grep -rn "products/homechef/format" apps/web --include='*.ts' --include='*.tsx' || echo "no local format imports remain"
```
Expected: the second grep prints "no local format imports remain".

- [ ] **Step 3: Delete the now-unused local file**

```bash
git rm apps/web/lib/products/homechef/format.ts
```

- [ ] **Step 4: Install, build the package, then verify web builds/typechecks/tests**

Run:
```bash
pnpm install
pnpm --filter @tesserix/homechef-shared build
pnpm --filter web typecheck
pnpm --filter web test:unit
pnpm --filter web build
```
Expected: all green. `typecheck` resolves `@tesserix/homechef-shared` types from `dist/index.d.ts`; `build` produces the standalone output with no unresolved-import errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web pnpm-lock.yaml
git commit -m "refactor(web): consume format from @tesserix/homechef-shared"
```

---

### Task 4: Repoint `apps/mobile` to the shared package, add monorepo Metro config, delete its local `format.ts`

This is the integration-risk task: Metro must resolve a hoisted workspace package.

**Files:**
- Create: `apps/mobile/metro.config.ts`
- Modify: `apps/mobile/package.json` (add workspace dep)
- Modify: the 6 mobile files importing the local format module
- Delete: `apps/mobile/lib/format.ts`

**Interfaces:**
- Consumes: `@tesserix/homechef-shared`.

- [ ] **Step 1: Create `apps/mobile/metro.config.ts`** (Expo's documented monorepo config)

```ts
// Learn more: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so Metro sees the shared package's dist.
config.watchFolders = [workspaceRoot];
// Resolve modules from the app first, then the hoisted workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
```

- [ ] **Step 2: Add the workspace dependency to `apps/mobile/package.json`**

Add to `dependencies` (keep all existing):
```json
    "@tesserix/homechef-shared": "workspace:*"
```

- [ ] **Step 3: Repoint every mobile import of the local format module**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
# mobile imports the file as "@/lib/format" (alias) and/or relative "../lib/format" / "./format"
grep -rl "lib/format\|/format\"" apps/mobile/app apps/mobile/components --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' -E "s#['\"](@/lib/format|(\.{1,2}/)+(lib/)?format)['\"]#\"@tesserix/homechef-shared\"#g"
grep -rn "lib/format\|from ['\"]\.[^'\"]*format['\"]" apps/mobile/app apps/mobile/components --include='*.ts' --include='*.tsx' || echo "no local format imports remain"
```
Expected: the second grep prints "no local format imports remain". (If a stray import specifier didn't match, edit it by hand to `@tesserix/homechef-shared`.)

- [ ] **Step 4: Delete the now-unused local file**

```bash
git rm apps/mobile/lib/format.ts
```

- [ ] **Step 5: Install, build the package, verify mobile typechecks**

Run:
```bash
pnpm install
pnpm --filter @tesserix/homechef-shared build
pnpm --filter mobile typecheck
```
Expected: `tsc --noEmit` exits 0 (the same pre-existing expo peer-dep warnings are fine; a REAL unresolved-module error for `@tesserix/homechef-shared` is a failure — fix Metro/tsconfig paths, not the package).

- [ ] **Step 6: Metro bundle smoke — prove Metro resolves the package**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/apps/mobile
npx expo export --platform ios --output-dir /tmp/mobile-export-smoke 2>&1 | tail -20
rm -rf /tmp/mobile-export-smoke
```
Expected: the export bundles successfully with NO `Unable to resolve module @tesserix/homechef-shared` error. This is the definitive proof Metro consumes the workspace package. If it fails to resolve, re-check `metro.config.ts` `watchFolders`/`nodeModulesPaths` and that `dist/` was built.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/package.json apps/mobile/metro.config.ts apps/mobile pnpm-lock.yaml
git commit -m "refactor(mobile): consume format from @tesserix/homechef-shared + monorepo metro config"
```

---

### Task 5: Full-workspace verification

Prove single-sourcing and that the whole workspace is coherent.

**Files:** none (verification).

- [ ] **Step 1: Confirm `format.ts` is single-sourced (only in the package)**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
test ! -f apps/web/lib/products/homechef/format.ts && test ! -f apps/mobile/lib/format.ts \
  && echo "both local homechef format.ts deleted" || echo "STILL PRESENT"
ls packages/homechef-shared/src/format.ts
```
Expected: "both local homechef format.ts deleted"; the shared `packages/homechef-shared/src/format.ts` exists. (Note: `apps/web/components/admin/metrics/format.ts` and `apps/web/lib/utils.ts` are UNRELATED formatters — leave them alone.)

- [ ] **Step 2: Clean install and run every workspace task via Turborepo**

Run:
```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules .turbo
pnpm install --frozen-lockfile
pnpm run build && pnpm run typecheck && pnpm run test
```
Expected: `--frozen-lockfile` in sync; turbo builds `@tesserix/homechef-shared` before the apps (dependency order); web build + all typechecks + tests (including the new format tests) green.

- [ ] **Step 3: Commit any lockfile updates and push the branch**

```bash
git add pnpm-lock.yaml
git diff --cached --quiet || git commit -m "chore: lockfile after shared-format extraction"
git push -u origin feat/shared-format
```
Expected: branch CI runs install/lint/test only (no image build/push, no deploy — the guard is `main`-only). Open a PR when green.

---

## Explicitly out of scope (next plans)

- **`contracts.ts` de-dup** — the biggest win, but it carries real type drift (`ReviewRow`, `MealPlanRow`, `PendingPayout`, `OrderIssue`, `ApprovalRequest`) that must be reconciled against the **live HomeChef admin API** (no local Go repo). That needs its own plan: (1) determine each drifted type's true shape from an actual `/api/admin/apps/homechef/gw/...` response, (2) fix whichever app is wrong, (3) move the reconciled superset into `@tesserix/homechef-shared`.
- **HttpClient port + gateway path constants** (Phase 2).
- **Data-fetching hooks, theme, auth** — platform-specific, stay per-app.

## Notes for the executor

- The package MUST be built (`dist/` present) before app typechecks/bundles — `tsc` and Metro consume `dist/index.d.ts` / `dist/index.js`, not `src`. `turbo run build` handles ordering via `dependsOn: ["^build"]`; when running app checks directly, build the package first.
- `sed -i ''` is the macOS form (BSD sed); the empty-string arg is required. On Linux use `sed -i`.
- If Metro can't resolve the package, the fix is always `metro.config.ts` (`watchFolders` + `nodeModulesPaths` + `disableHierarchicalLookup`) plus a built `dist/` — never vendoring the file back into the app.
- The repoint `sed` in Tasks 3 & 4 targets the alias/relative specifiers seen today; if `pnpm --filter web typecheck` or `pnpm --filter mobile typecheck` then fails with an unresolved import of a `format` module, that is simply an import site the `sed` missed — find it (`grep -rn "format" <app>` around the error) and repoint it to `@tesserix/homechef-shared`. The typecheck is the backstop that guarantees no straggler survives.
