# Monorepo Restructure (pnpm + Turborepo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `tesserix-home` into a pnpm + Turborepo monorepo (`apps/web`, `apps/mobile`, `packages/*`) without breaking CI/CD or changing any app behavior.

**Architecture:** All web files move to `apps/web`; the existing Expo app moves to `apps/mobile`. A pnpm workspace + Turborepo wraps both, with config-only shared packages. The Docker image name/tag stays identical (`tesserix-home:main-<sha>`) so Kargo → Argo CD are untouched.

**Tech Stack:** pnpm 10.17.1, Turborepo 2.8.10, Next.js 16 (standalone), Expo/React Native, Docker (node:22-alpine), GitHub Actions.

## Global Constraints

- **CI/CD must not break.** CI must keep emitting `ghcr.io/<owner>/tesserix-home:main-<sha7>` and `:latest` with the exact same tag-derivation logic. Kargo/Argo CD key off image name+tag only.
- **No behavior change.** No feature, UI, or runtime-logic change to either app. Config-only shared packages.
- **Package manager:** pnpm `10.17.1` exactly. `node-linker=hoisted` (Expo/Metro requirement).
- **Turborepo:** `2.8.10` (org standard).
- **Node:** 22 in CI and Docker.
- **Preserve git history:** use `git mv` for all tracked-file moves.
- **De-dup deferred:** do NOT move `api`/`auth`/`contracts`/`format` business logic between apps.
- **Repo-level files stay at root:** `.github/`, `docs/`, `.planning/`, `.claude/`, `BACKLOG.md`, `MIGRATION-MATRIX.md`, `README.md`, `Dockerfile`, `.dockerignore`, `.gitignore`.
- **Image build context stays repo root** (`docker build .`) — do not move the Dockerfile.

**Recommended:** execute on a `feat/monorepo-restructure` branch so CI runs and pushes a proof image before merging to `main` (per spec rollout).

---

### Task 1: Relocate the web app into `apps/web`

Move every web-specific file/dir from the repo root into `apps/web/`, preserving git history. Nothing builds after this task yet — the gate is purely structural.

**Files:**
- Move dirs → `apps/web/`: `app/`, `components/`, `contexts/`, `db/`, `hooks/`, `lib/`, `public/`, `scripts/`, `tests/`
- Move files → `apps/web/`: `middleware.ts`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `next-env.d.ts`, `package.json`, `.env.example`
- Move untracked (plain `mv`): `.env.local`
- Delete: root `package-lock.json`, root `pnpm-lock.yaml` (stray)

- [ ] **Step 1: Create the apps/web directory and move tracked web dirs + files**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
mkdir -p apps/web
git mv app components contexts db hooks lib public scripts tests apps/web/
git mv middleware.ts next.config.ts tsconfig.json eslint.config.mjs \
       postcss.config.mjs vitest.config.ts playwright.config.ts \
       next-env.d.ts package.json .env.example apps/web/
```

- [ ] **Step 2: Move the untracked local env file and delete stale lockfiles**

```bash
mv .env.local apps/web/.env.local 2>/dev/null || echo "no .env.local to move"
rm -f package-lock.json pnpm-lock.yaml
```

- [ ] **Step 3: Verify the root is clean and apps/web is populated**

Run:
```bash
ls apps/web && echo "---ROOT---" && ls -1
```
Expected: `apps/web` lists `app components contexts db hooks lib public scripts tests middleware.ts next.config.ts package.json …`. Root no longer lists `app`, `lib`, `middleware.ts`, `package.json`, or any lockfile; root still has `docs`, `.github`, `.planning`, `Dockerfile`, `mobile`, `README.md`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move web app into apps/web"
```

---

### Task 2: Relocate the Expo app into `apps/mobile`

**Files:**
- Move dir → `apps/mobile/`: current `mobile/` (all tracked files)
- Delete: `apps/mobile/package-lock.json` (npm lock, replaced by the workspace pnpm lock)

- [ ] **Step 1: Remove regenerable mobile artifacts, then move the folder**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
rm -rf mobile/node_modules
git mv mobile apps/mobile
git rm --cached apps/mobile/package-lock.json 2>/dev/null || true
rm -f apps/mobile/package-lock.json
```

- [ ] **Step 2: Verify mobile moved intact**

Run:
```bash
ls apps/mobile && echo "---" && ls apps/mobile/app
```
Expected: `apps/mobile` lists `app app.json babel.config.js components lib package.json tsconfig.json`; `apps/mobile/app` lists `(auth) (tabs) homechef _layout.tsx`. No `mobile/` at root.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: move expo app into apps/mobile"
```

---

### Task 3: Create the pnpm + Turborepo workspace root

Add the workspace config, a new thin root `package.json`, Turborepo config, `.npmrc`, wire each app's `package.json`, then generate one fresh lockfile.

**Files:**
- Create: `pnpm-workspace.yaml`, `.npmrc`, `turbo.json`, `package.json` (new root)
- Modify: `apps/web/package.json`, `apps/mobile/package.json`
- Generate: `pnpm-lock.yaml`

**Interfaces:**
- Produces: workspace package names `web`, `mobile`; root scripts `build`/`lint`/`test`/`typecheck`/`dev` delegating to `turbo`.

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Create `.npmrc`** (Expo/Metro cannot follow pnpm's default symlinked store)

```
node-linker=hoisted
shamefully-hoist=true
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "lint": {},
    "typecheck": {},
    "test:unit": {},
    "test": {},
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

- [ ] **Step 4: Create the new thin root `package.json`**

```json
{
  "name": "tesserix-home",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@10.17.1",
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test:unit",
    "dev": "turbo run dev"
  },
  "devDependencies": {
    "turbo": "^2.8.10"
  },
  "pnpm": {
    "overrides": {
      "@babel/core": "^7.29.6",
      "brace-expansion@1": "^1.1.13",
      "brace-expansion@5": "^5.0.6",
      "esbuild": "^0.28.1",
      "flatted": "^3.4.2",
      "js-yaml@4": "^4.2.0",
      "linkify-it": "^5.0.1",
      "markdown-it": "^14.2.0",
      "picomatch@2": "^2.3.2",
      "picomatch@4": "^4.0.4",
      "postcss": "^8.5.10"
    }
  }
}
```

- [ ] **Step 5: Edit `apps/web/package.json`** — set `name` to `web`, harden the `lint` script (preserve the `--max-warnings 0` CI gate), add `typecheck`, and declare the two shared workspace packages. Change the top of the file:

```json
{
  "name": "web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3002",
    "build": "next build",
    "start": "next start",
    "lint": "eslint --max-warnings 0",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "test:unit:watch": "vitest",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:headed": "playwright test --headed",
    "db:migrate": "node scripts/db-migrate.mjs"
  },
```

Also **remove** the now-obsolete top-level npm `"overrides"` block and the `"pnpm"` block from `apps/web/package.json` (they now live in the root `package.json`). Leave `dependencies` untouched. The `workspace:*` deps on the shared packages are added in Task 4 (after those packages exist).

- [ ] **Step 6: Confirm `apps/mobile/package.json`** — verify `"name": "mobile"` is set (it already is). No dependency changes here; the shared tsconfig workspace dep is added in Task 4.

- [ ] **Step 7: Generate a fresh single lockfile**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
corepack enable && corepack prepare pnpm@10.17.1 --activate
pnpm install
```
Expected: install succeeds cleanly and writes `pnpm-lock.yaml` (no unresolved-workspace warnings, since no `workspace:*` deps are declared yet).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: add pnpm workspace + turborepo root config"
```

---

### Task 4: Add config-only shared packages and wire both apps

Create `packages/tsconfig` and `packages/eslint-config` (zero runtime code), point web + mobile at them, and prove lint/typecheck still pass unchanged.

**Files:**
- Create: `packages/tsconfig/package.json`, `packages/tsconfig/base.json`
- Create: `packages/eslint-config/package.json`, `packages/eslint-config/index.mjs`
- Create: `packages/README.md`
- Modify: `apps/web/tsconfig.json`, `apps/web/eslint.config.mjs`, `apps/mobile/tsconfig.json`

**Interfaces:**
- Produces: `@tesserix/tsconfig/base.json` (shared compiler baseline); `@tesserix/eslint-config` default export `{ sharedRules }` (named export) — an ESLint flat-config rules object.

- [ ] **Step 1: Create `packages/tsconfig/package.json`**

```json
{
  "name": "@tesserix/tsconfig",
  "version": "0.0.0",
  "private": true,
  "files": ["base.json"]
}
```

- [ ] **Step 2: Create `packages/tsconfig/base.json`** (only safe, already-effective flags — no behavior change)

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 3: Create `packages/eslint-config/package.json`**

```json
{
  "name": "@tesserix/eslint-config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "index.mjs"
}
```

- [ ] **Step 4: Create `packages/eslint-config/index.mjs`** — the shared custom rules, copied verbatim from the current web config so effective linting is identical

```js
// Shared custom ESLint rule overrides for Tesserix apps (flat-config block).
export const sharedRules = {
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-empty-object-type": "off",
    "react/no-unescaped-entities": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
    "prefer-const": "warn",
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/immutability": "off",
    "import/no-anonymous-default-export": "off",
  },
};
```

- [ ] **Step 5: Create `packages/README.md`** documenting the deferred de-dup targets

```markdown
# packages/

Shared workspace packages for the Tesserix monorepo.

- **tsconfig** — `@tesserix/tsconfig`: shared TypeScript compiler baseline (`base.json`).
- **eslint-config** — `@tesserix/eslint-config`: shared ESLint custom-rule block.

Both are **config-only** — no runtime/business logic lives here yet.

## Deferred de-duplication (next effort)

The web app (`apps/web/lib`) and mobile app (`apps/mobile/lib`) currently keep
parallel copies of the same concepts. These are the intended targets for a future
`packages/shared` (pure TypeScript — no UI, since React and React Native primitives differ):

- `contracts.ts` — shared API/domain types (zod schemas + inferred types)
- `api.ts` — API client / request logic
- `auth` — auth token + session helpers
- `format.ts` — formatting utilities

Not moved in the monorepo-restructure effort (2026-07-24) to keep it behavior-neutral.
```

- [ ] **Step 6: Wire `apps/web/tsconfig.json`** — add `extends` and drop the obsolete `"mobile"` exclude (mobile is no longer nested). Replace the file with:

```json
{
  "extends": "@tesserix/tsconfig/base.json",
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 7: Wire `apps/web/eslint.config.mjs`** — consume the shared rules, drop the `mobile/**` ignore. Replace the file with:

```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { sharedRules } from "@tesserix/eslint-config";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  sharedRules,
]);

export default eslintConfig;
```

- [ ] **Step 8: Wire `apps/mobile/tsconfig.json`** — use array `extends` (TS 5.9 supports it) to layer the shared baseline over Expo's. Replace the file with:

```json
{
  "extends": ["expo/tsconfig.base", "@tesserix/tsconfig/base.json"],
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "paths": { "@/*": ["./*"] }
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

- [ ] **Step 9: Declare the shared packages as workspace deps in each app**

In `apps/web/package.json`, add to `devDependencies` (keep all existing entries):

```json
    "@tesserix/tsconfig": "workspace:*",
    "@tesserix/eslint-config": "workspace:*"
```

In `apps/mobile/package.json`, add to `devDependencies` (keep existing `@types/react`, `typescript`):

```json
    "@tesserix/tsconfig": "workspace:*"
```

- [ ] **Step 10: Re-install so the new workspace packages link**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
pnpm install
```
Expected: clean install, `@tesserix/tsconfig` and `@tesserix/eslint-config` resolve as workspace links, `pnpm-lock.yaml` updated.

- [ ] **Step 11: Verify web lint + typecheck and mobile typecheck all pass**

Run:
```bash
pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter mobile typecheck
```
Expected: all three exit 0 (web lint with `--max-warnings 0`). If web lint reports new warnings/errors, the shared config diverged from the original — reconcile `packages/eslint-config/index.mjs` against the pre-move rules until lint is clean.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: add shared tsconfig + eslint-config packages"
```

---

### Task 5: Make the web build produce correct standalone output for the monorepo

Next's `standalone` output must trace from the repo root so hoisted `node_modules` are included and `server.js` lands at a known path.

**Files:**
- Modify: `apps/web/next.config.ts`

- [ ] **Step 1: Add `outputFileTracingRoot` to `apps/web/next.config.ts`** — add the import at the top of the file (below the existing `import type`):

```ts
import path from "node:path";
```

Then add this key to the `nextConfig` object, immediately after `output: 'standalone',`:

```ts
  // Trace files from the monorepo root so the standalone bundle includes the
  // hoisted workspace node_modules (server.js emits at apps/web/server.js).
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
```

- [ ] **Step 2: Build the web app**

Run:
```bash
pnpm --filter web build
```
Expected: build succeeds; output notes the standalone build.

- [ ] **Step 3: Verify the standalone entrypoint path exists**

Run:
```bash
ls apps/web/.next/standalone/apps/web/server.js && ls -d apps/web/.next/standalone/node_modules
```
Expected: both paths exist — `apps/web/.next/standalone/apps/web/server.js` and a hoisted `.../standalone/node_modules` directory.

- [ ] **Step 4: Smoke-run the standalone server locally**

Run:
```bash
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/public apps/web/.next/standalone/apps/web/public
PORT=3000 node apps/web/.next/standalone/apps/web/server.js &
sleep 4 && curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/ ; kill %1
```
Expected: an HTTP status line (200, or a 3xx/redirect from middleware/auth) — anything other than connection-refused proves the server boots. Then clean up: `rm -rf apps/web/.next/standalone/apps/web/.next/static apps/web/.next/standalone/apps/web/public`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/next.config.ts
git commit -m "fix(web): trace standalone output from monorepo root"
```

---

### Task 6: Rewrite the Dockerfile and .dockerignore for the workspace build

Keep root build context and image name/tag; adapt install (pnpm, web-only), build (`pnpm --filter web build`), and the standalone copy/run paths.

**Files:**
- Modify: `Dockerfile`
- Modify: `.dockerignore`

- [ ] **Step 1: Replace `Dockerfile`** with the workspace-aware multi-stage build

```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

# Copy workspace manifests + lockfile first for cached, deterministic installs
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json

# Install only what the web app needs (skips the React Native toolchain)
RUN pnpm install --frozen-lockfile --filter web...

# Copy sources and build the web app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Standalone bundle (contains apps/web/server.js + hoisted node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

CMD ["node", "apps/web/server.js"]
```

- [ ] **Step 2: Replace `.dockerignore`** to cover the workspace tree

```
# Dependencies (all workspaces)
**/node_modules
.pnp
.pnp.js

# Build output
**/.next
**/.expo
**/out
**/build
**/dist

# Testing
**/coverage
**/test-results
**/playwright-report
**/playwright/.cache

# Repo-level (not needed in image)
.git
.github
docs
.planning
.idea
.vscode

# Misc
**/.DS_Store
*.pem
**/*.tsbuildinfo
**/next-env.d.ts

# Env
**/.env*.local
**/.env

# Debug
**/npm-debug.log*
**/yarn-debug.log*
**/yarn-error.log*
```

- [ ] **Step 3: Build the image locally (the real CI/CD proof)**

Run:
```bash
docker build --platform linux/amd64 -t tesserix-home:monorepo-test .
```
Expected: build completes through both stages with no error.

- [ ] **Step 4: Run the container and confirm it serves**

Run:
```bash
docker run -d --rm -p 3000:3000 --name tesserix-web-test tesserix-home:monorepo-test
sleep 5 && curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/ ; docker logs tesserix-web-test | tail -20 ; docker stop tesserix-web-test
```
Expected: an HTTP status line (200 or a redirect), and logs showing Next.js started on port 3000. Connection-refused or a crash-loop means the standalone COPY paths are wrong — reconcile against Task 5 Step 3.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: workspace-aware Dockerfile for standalone web image"
```

---

### Task 7: Update CI and Release workflows (and root .gitignore)

Adapt install/lint/test to pnpm and update trigger paths. **Do not touch** the image name, tag logic, docker build/push, Trivy, or SARIF steps.

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Update `.github/workflows/ci.yml` trigger `paths`** — replace the existing `push.paths` list with:

```yaml
    paths:
      - 'apps/web/**'
      - 'packages/**'
      - 'pnpm-workspace.yaml'
      - 'pnpm-lock.yaml'
      - 'turbo.json'
      - '.npmrc'
      - 'Dockerfile'
      - '.dockerignore'
      - 'package.json'
      - '.github/workflows/ci.yml'
```

- [ ] **Step 2: Update `ci.yml` install/lint/test steps** — replace the `Set up Node.js`, `Install dependencies`, `Lint`, and `Unit tests` steps with:

```yaml
      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10.17.1

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm --filter web lint

      - name: Unit tests
        run: pnpm --filter web test:unit
```

Leave every later step (`Log in`, `Extract metadata`, `Build and push`, `Security scan`, `Upload scan results`) exactly as-is — same `IMAGE_NAME: tesserix-home`, same `docker build ... .`, same tag logic.

- [ ] **Step 3: Update `.github/workflows/release.yml`** — replace its `Set up Node.js`, `Install dependencies`, and `Lint` steps with the same pnpm block:

```yaml
      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10.17.1

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm --filter web lint
```

Leave the `Extract metadata`, `Build and push`, `Security scan`, and `Upload scan results` steps unchanged.

- [ ] **Step 4: Append monorepo ignores to root `.gitignore`**

Add these lines to `.gitignore`:

```
# Monorepo workspaces
**/node_modules
apps/*/.next
apps/*/.expo
packages/*/dist
.turbo
**/*.tsbuildinfo
```

- [ ] **Step 5: Validate the workflow YAML parses**

Run:
```bash
python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci.yml','.github/workflows/release.yml']]; print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml .gitignore
git commit -m "ci: pnpm workspace install/lint/test + monorepo trigger paths"
```

---

### Task 8: Full-workspace verification and CI proof

Prove the whole workspace is coherent, then confirm CI builds the identical image before merging to `main`.

**Files:** none (verification + rollout).

- [ ] **Step 1: Clean install and run every workspace task via Turborepo**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
rm -rf node_modules apps/*/node_modules packages/*/node_modules .turbo
pnpm install --frozen-lockfile
pnpm run lint && pnpm run typecheck && pnpm run build
```
Expected: `pnpm install --frozen-lockfile` succeeds (lockfile is in sync); turbo runs `lint`, `typecheck`, and `build` across web (and mobile where defined) with all tasks green.

- [ ] **Step 2: Confirm mobile still starts (Metro resolution under pnpm)**

Run:
```bash
pnpm --filter mobile typecheck
```
Expected: exit 0. (Optionally `pnpm --filter mobile exec expo-doctor` if available; a full `expo start` is not required for this restructure.)

- [ ] **Step 3: Push the feature branch and confirm CI emits the proof image**

Run:
```bash
git push -u origin feat/monorepo-restructure
```
Then in GitHub Actions, confirm the `CI` run: `pnpm install` → `pnpm --filter web lint` → `pnpm --filter web test:unit` → `docker build` all pass, and a `ghcr.io/<owner>/tesserix-home:main-<sha>` image is pushed with the Trivy scan running. This is the definitive "CI/CD did not break" check.

- [ ] **Step 4: Merge to `main`**

After the image is confirmed in Actions, open/merge the PR to `main`. Watch Kargo auto-promote the new `main-<sha>` image and Argo CD sync the `company` Application — no manifest changes required (image name/tag unchanged).

- [ ] **Step 5: Final commit (if any local cleanup remains)**

```bash
git status
# commit only if uncommitted verification cleanup remains
```

---

## Notes for the executor

- If `pnpm install --frozen-lockfile` fails in CI with a lockfile-mismatch, it means a manifest changed after the lockfile was generated. Re-run `pnpm install` locally, commit the updated `pnpm-lock.yaml`, and push.
- If the Docker container crash-loops on `Cannot find module`, the standalone COPY paths are the cause — re-verify against Task 5 Step 3 (`apps/web/.next/standalone/apps/web/server.js`).
- Do not add mobile paths to `ci.yml` triggers — mobile edits must not rebuild the web image.
