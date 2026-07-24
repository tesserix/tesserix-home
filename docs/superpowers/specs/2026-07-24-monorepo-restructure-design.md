# Design: tesserix-home → pnpm + Turborepo monorepo

**Date:** 2026-07-24
**Status:** Approved design, pending spec review
**Scope:** Restructure only — no new features, no UI changes, no behavior changes.

## Problem

`tesserix-home` is a Next.js 16 admin portal + marketing site at the repo root. An
Expo/React Native admin app already exists nested at `mobile/`, git-tracked, with real
screens (login, tabs, a `homechef` admin section). There is **no monorepo tooling**
(no `pnpm-workspace.yaml`, no `turbo.json`) — mobile is just a nested folder.

Duplication is already happening: `mobile/lib/` has its own `api.ts`, `auth.tsx`,
`contracts.ts`, `format.ts`, `hooks.ts` — parallel copies of concepts in the web `lib/`.
The `homechef` refund feature shipped to **both** web and mobile in one commit (#31), so
the two apps drift in lockstep by hand.

Goal: formalize web + mobile into a proper **pnpm + Turborepo** monorepo so both apps are
first-class, tooling is shared, and future de-duplication has a home — **without breaking
CI/CD**.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Scope | Monorepo restructure only. No feature work, no behavior change. |
| Tooling | **pnpm 10.17.1 + Turborepo** (aligns with org standard; design-system already uses pnpm). |
| Web app | Marketing + admin stay as **one** Next app (`apps/web`). No split now. |
| Lockfiles | **Regenerate clean** — delete all existing npm + stray pnpm lockfiles, produce one fresh `pnpm-lock.yaml`. |
| De-dup | **Deferred.** Duplicated `api`/`auth`/`contracts`/`format` stay as-is; documented as next step. |
| Hard constraint | **CI/CD must not break.** |

## Target layout

```
tesserix-home/                    (same repo, same name)
├── apps/
│   ├── web/                      ← everything web currently at root
│   │   ├── app/  lib/  components/  contexts/  db/  hooks/  scripts/  tests/  public/
│   │   ├── middleware.ts  next.config.ts  tsconfig.json
│   │   ├── eslint.config.mjs  postcss.config.mjs  vitest.config.ts  playwright.config.ts
│   │   ├── .env.example  .env.local
│   │   └── package.json          (name: "web")
│   └── mobile/                   ← current mobile/ moved verbatim
│       └── package.json          (name: "mobile", deps unchanged)
├── packages/
│   ├── tsconfig/                 shared base tsconfig (config only)
│   ├── eslint-config/            shared eslint base (config only)
│   └── README.md                 documents future de-dup targets (contracts/api/auth/format)
├── .github/                      stays at repo root (repo-level)
├── docs/  .planning/             stay at repo root (repo-level)
├── Dockerfile                    stays at repo root (root build context — keeps `docker build .`)
├── .dockerignore
├── package.json                  root: workspaces + turbo-delegating scripts only
├── pnpm-workspace.yaml
├── turbo.json
├── .npmrc                        node-linker=hoisted (Expo/Metro compatibility)
└── pnpm-lock.yaml                single fresh lockfile
```

**Stays at repo root (repo-level, does NOT move into apps/web):** `.github/`, `docs/`,
`.planning/`, `BACKLOG.md`, `MIGRATION-MATRIX.md`, `README.md`, `.gitignore`, `Dockerfile`,
`.dockerignore`.

**Moves into `apps/web/` (web-specific):** `app/`, `lib/`, `components/`, `contexts/`,
`db/`, `hooks/`, `scripts/`, `tests/`, `public/`, `middleware.ts`, `next.config.ts`,
`tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `vitest.config.ts`,
`playwright.config.ts`, `next-env.d.ts`, `.env.example`, `.env.local`, and the web
`package.json`.

All moves use `git mv` to preserve history.

## Component 1 — Package-manager migration (npm → pnpm)

- Delete root `package-lock.json` and `mobile/package-lock.json`, plus the stray root
  `pnpm-lock.yaml`. Regenerate one fresh `pnpm-lock.yaml` at the root via `pnpm install`.
- `pnpm-workspace.yaml` globs `apps/*` and `packages/*`.
- `.npmrc` at root with `node-linker=hoisted` and `shamefully-hoist=true`. Rationale:
  Metro (Expo's bundler) cannot follow pnpm's default symlinked store; the hoisted linker
  produces a flat `node_modules` Metro can resolve. This is the documented Expo-on-pnpm setup.
- Root `package.json`: `"packageManager": "pnpm@10.17.1"`, `"private": true`, workspace-level
  scripts that delegate to turbo (`build`, `lint`, `test`, `dev`). Move the existing `pnpm.overrides`
  block from the old root `package.json` to preserve dependency pins.
- `apps/web/package.json`: the current root deps/devDeps/scripts, renamed `"name": "web"`.
- `apps/mobile/package.json`: unchanged except confirming `"name": "mobile"`.

## Component 2 — Turborepo config

- `turbo.json` with pipeline tasks: `build` (depends on `^build`, outputs `.next/**` for web),
  `lint`, `test`, `typecheck`. `dev` marked persistent/no-cache.
- Root scripts: `pnpm build` → `turbo run build`, etc. Per-app still runnable via
  `pnpm --filter web <script>` / `pnpm --filter mobile <script>`.

## Component 3 — Shared config packages (config only, zero runtime)

- `packages/tsconfig/base.json` — shared compiler options; `apps/web` and `apps/mobile`
  tsconfigs `extends` it. Preserve each app's existing app-specific settings (paths, jsx, etc.).
- `packages/eslint-config/` — shared eslint base; web extends it alongside `eslint-config-next`.
- These packages contain **no application code**. No `api`/`auth`/`contracts` logic moves.
- `packages/README.md` records the deferred de-dup targets (`contracts.ts`, `api.ts`, `auth`,
  `format.ts`) as the explicit next effort.

## Component 4 — CI/CD safety (the critical constraint)

**Safety anchor:** deploy is decoupled from the repo structure. `ci.yml` builds and pushes
`ghcr.io/<owner>/tesserix-home:main-<sha7>` (and `:latest`); Kargo watches for that image
name+tag, auto-promotes, and Argo CD syncs. **As long as CI emits the identical image name
and tag scheme, every downstream system is untouched.** The restructure must preserve that.

Changes to `.github/workflows/ci.yml`:

- **Trigger `paths`** → `apps/web/**`, `packages/**`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `turbo.json`, `Dockerfile`, `.npmrc`, `.github/workflows/ci.yml`.
  Mobile paths deliberately **excluded** — mobile edits must not trigger a web image build.
- **Install** → `pnpm/action-setup` (v10.17.1) + `pnpm install --frozen-lockfile` (replaces `npm ci`).
- **Lint** → `pnpm --filter web lint` (replaces `npx eslint . --max-warnings 0`; keep the
  `--max-warnings 0` strictness inside the web lint script).
- **Unit tests** → `pnpm --filter web test:unit` (replaces `npm run test:unit`).
- **Unchanged**: `REGISTRY=ghcr.io`, `IMAGE_NAME=tesserix-home`, the `main-${SHA::7}` /
  tag-derivation logic, `docker build --platform linux/amd64 ... .` (root context),
  `docker push --all-tags`, the Trivy scan step, and the best-effort SARIF upload.
- `release.yml` gets the same install/build treatment (audit and align it with `ci.yml`).

Net effect on Kargo/Argo CD: **none** — same image, same tag.

## Component 5 — Dockerfile rewrite (Next standalone in a workspace)

The gotcha: Next's `standalone` output layout shifts under a workspace. Plan:

- In `apps/web/next.config.ts`, set
  `outputFileTracingRoot: path.join(__dirname, '../../')` so file tracing captures the
  hoisted workspace `node_modules`. Keep `output: 'standalone'` and all existing headers/CSP.
- **Builder stage** (root build context): copy `pnpm-workspace.yaml`, `.npmrc`, root
  `package.json`, `pnpm-lock.yaml`, and each workspace `package.json` → `corepack`/install
  pnpm → `pnpm install --frozen-lockfile` → copy sources → `pnpm --filter web build`.
- Standalone now emits under `apps/web/.next/standalone/` containing `apps/web/server.js`
  plus a hoisted `node_modules`.
- **Runner stage**: copy `apps/web/.next/standalone` → `./`, `apps/web/.next/static` →
  `./apps/web/.next/static`, and `apps/web/public` → `./apps/web/public`. Same
  `node:22-alpine`, same non-root `nextjs` user, same `PORT=3000`/`HOSTNAME=0.0.0.0`.
  `CMD ["node", "apps/web/server.js"]`.
- Update `.dockerignore` for the new tree (ignore `apps/*/node_modules`, `apps/*/.next`, etc.).

## Mobile CI

Mobile currently has no CI workflow and is not in `ci.yml` triggers. Post-restructure it
stays that way (built via EAS externally). We only ensure `pnpm --filter mobile typecheck`
passes locally so the workspace is coherent. Adding mobile CI is out of scope.

## Error handling / risk mitigation

- **Frozen-lockfile drift:** regenerating the lockfile cleanly (locked decision) avoids
  inheriting a stale lock that would fail `--frozen-lockfile` in CI.
- **Standalone path errors:** the top risk. Mitigated by building the Docker image locally
  and running the container **before merge** (see rollout).
- **Metro resolution failures under pnpm:** mitigated by `node-linker=hoisted`; verified by
  `pnpm --filter mobile typecheck` and an Expo start smoke check.

## Verification & rollout order

1. Land structure + tooling. `pnpm install` clean; `pnpm --filter web build` green;
   `pnpm --filter mobile typecheck` green; `pnpm --filter web test:unit` green.
2. **Build the Docker image locally and run the container** — the real CI/CD proof. Confirm
   the web app serves on `:3000` from `node apps/web/server.js`.
3. Push to a `feat/**` branch. CI runs (pushes image on non-PR). Confirm the
   `tesserix-home:main-<sha>` image builds and pushes in Actions, and Trivy runs.
4. Merge to `main` only after the image is confirmed. Watch Kargo auto-promote → Argo CD sync.

## Explicitly out of scope

- De-duplicating `api`/`auth`/`contracts`/`format` between web and mobile.
- Splitting marketing from admin.
- Adding mobile CI/CD (EAS pipeline).
- Any UI, feature, or behavior change to either app.
