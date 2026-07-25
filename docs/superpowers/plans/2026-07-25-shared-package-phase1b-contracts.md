# Shared Package Phase 1b — `contracts.ts` De-dup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-duplicate the HomeChef admin API `contracts.ts` by moving the WEB (canonical superset) version into `@tesserix/homechef-shared` and repointing both apps to it, ending the drift between the two hand-synced copies.

**Architecture:** Extends the shared package created in Phase 1a (PR #52). The WEB `contracts.ts` (960 lines, pure types + pure runtime helpers, zero imports) becomes the single source of truth. `apps/mobile` adopts the web shapes; the two conflicting types (`ReviewRow`, `MealPlanRow`) drop mobile's stale fields — verified safe because mobile renders none of them (no reviews/meal-plans screen exists).

**Tech Stack:** TypeScript, tsup, Vitest, pnpm + Turborepo.

**Prerequisite:** Phase 1a (PR #52) — the `@tesserix/homechef-shared` package, `apps/mobile/metro.config.ts`, the Dockerfile build-order, and `turbo.json` `^build` deps must be present. Execute this on a branch based off `feat/shared-format` (stacked on #52) OR off `main` after #52 merges. Same tasks either way.

## Global Constraints

- **Canonical = WEB, wholesale.** `apps/web/lib/products/homechef/contracts.ts` is the superset and is deployed — every drifted field is rendered in a live web admin screen, which is empirical proof of the real Go API shape. Move it VERBATIM into the package.
- **No behavior change to the web app.** Web keeps the identical types/values (just imported from the package now).
- **Mobile drift resolution (the only semantic change):** mobile adopts web's `ReviewRow` (`overallRating` + `comment`; drops mobile's `rating`/`text`) and web's `MealPlanRow` (`total` + `days: MealPlanDayRow[]`; drops mobile's `mealCount`/`daysPerWeek`/`pricePerMeal`/`totalPrice`). This is safe: **no mobile screen renders those fields** (mobile has no reviews or meal-plans screen; the `useReviews`/`useMealPlans` hooks are unrendered). The other three drifts (`PendingPayout`, `OrderIssue`, `ApprovalRequest`) are pure additive unions — mobile gains optional fields it doesn't use.
- **The mobile typecheck gate is the proof of safety:** `pnpm --filter mobile typecheck` MUST pass after mobile adopts web's shapes. If it fails on a removed field, that field WAS used — stop and report (do not re-add the field to the shared type without reconciling against the Go API).
- **`contracts.ts` is pure** (no imports); it also exports runtime helpers (`CANCEL_REASONS`, `CancelReasonValue`, `parseSettlementRequirements`, `parseSegment`, `WINBACK_TRIGGER_LABEL`, `MEDIATION_ROLE_LABEL`, and other label maps) — all move with it.
- **Consumption:** both apps import from `@tesserix/homechef-shared` (built `dist`); index re-exports `./contracts` alongside `./format`. No name collisions (format vs contracts exports are disjoint).
- **Same build/verify discipline as Phase 1a:** package builds before consumers; `turbo run build/typecheck/test:unit` green; web `docker build` green; Metro `expo export` resolves the package.

## File Structure

```
packages/homechef-shared/
├── src/contracts.ts          NEW — verbatim copy of apps/web/lib/products/homechef/contracts.ts
├── src/index.ts              MODIFY — add `export * from "./contracts"`
apps/web/
├── lib/products/homechef/contracts.ts   DELETED (26 import sites repointed)
apps/mobile/
├── lib/contracts.ts          DELETED (4 import sites repointed; adopts web shapes)
```

---

### Task 1: Move web `contracts.ts` into the shared package

**Files:**
- Create: `packages/homechef-shared/src/contracts.ts` (verbatim copy of the web file)
- Modify: `packages/homechef-shared/src/index.ts`

**Interfaces:**
- Produces: `@tesserix/homechef-shared` additionally exports all HomeChef admin contract types + the runtime helpers `CANCEL_REASONS`, `CancelReasonValue`, `parseSettlementRequirements`, `parseSegment`, `WINBACK_TRIGGER_LABEL`, `MEDIATION_ROLE_LABEL` (and the other label-map consts), identical to the current web `contracts.ts`.

- [ ] **Step 1: Copy the web contracts file into the package verbatim**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
cp apps/web/lib/products/homechef/contracts.ts packages/homechef-shared/src/contracts.ts
# sanity: it is pure (no imports) so it moves without edits
grep -nE '^import |from "|require\(' packages/homechef-shared/src/contracts.ts || echo "no imports — clean move"
```
Expected: "no imports — clean move".

- [ ] **Step 2: Re-export it from `packages/homechef-shared/src/index.ts`**

The file currently contains `export * from "./format";`. Add a second line so it reads:
```ts
export * from "./format";
export * from "./contracts";
```

- [ ] **Step 3: Build the package and confirm contracts types are emitted**

Run:
```bash
pnpm --filter @tesserix/homechef-shared build
grep -c "ReviewRow\|MealPlanRow\|PendingPayout\|CANCEL_REASONS" packages/homechef-shared/dist/index.d.ts
```
Expected: build succeeds; the grep count is > 0 (contracts declarations are in the emitted `dist/index.d.ts`).

- [ ] **Step 4: Typecheck the package**

Run: `pnpm --filter @tesserix/homechef-shared typecheck`
Expected: exit 0 (the copied file is self-contained and type-correct).

- [ ] **Step 5: Commit**

```bash
git add packages/homechef-shared/src/contracts.ts packages/homechef-shared/src/index.ts
git commit -m "feat(homechef-shared): add HomeChef admin contracts (canonical = web superset)"
```

---

### Task 2: Repoint `apps/web` to the shared contracts and delete its local file

Web keeps identical types — this is a pure import-path change.

**Files:**
- Modify: `apps/web/package.json` (already depends on `@tesserix/homechef-shared` from Phase 1a — no change needed if present; add if missing)
- Modify: the 26 web files importing `products/homechef/contracts`
- Delete: `apps/web/lib/products/homechef/contracts.ts`

**Interfaces:**
- Consumes: contract types + helpers from `@tesserix/homechef-shared`.

- [ ] **Step 1: Confirm the workspace dep exists (added in Phase 1a)**

Run:
```bash
grep '@tesserix/homechef-shared' apps/web/package.json || echo "MISSING — add \"@tesserix/homechef-shared\": \"workspace:*\" to dependencies"
```
If missing, add `"@tesserix/homechef-shared": "workspace:*"` to `apps/web/package.json` dependencies.

- [ ] **Step 2: Repoint every web import of the local contracts module**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
grep -rl "products/homechef/contracts" apps/web --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' -E "s#['\"][^'\"]*products/homechef/contracts['\"]#\"@tesserix/homechef-shared\"#g"
grep -rn "products/homechef/contracts" apps/web --include='*.ts' --include='*.tsx' || echo "no local contracts imports remain"
```
Expected: "no local contracts imports remain".

> Note: some web files may import from BOTH `products/homechef/contracts` AND `products/homechef/format` (already repointed in 1a) — the sed only touches the contracts specifier; a file importing both now imports both from `@tesserix/homechef-shared`, which is fine (dedupe the two import lines if lint flags a duplicate import).

- [ ] **Step 3: Delete the local file**

```bash
git rm apps/web/lib/products/homechef/contracts.ts
```

- [ ] **Step 4: Build the package, then verify web typecheck + test + build**

Run:
```bash
pnpm install
pnpm --filter @tesserix/homechef-shared build
pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web test:unit && pnpm --filter web build
```
Expected: all green. Two straggler classes to fix if red: (a) an unresolved-import error on a `contracts` module = an import site the sed missed — repoint it; (b) an `import/no-duplicates` lint error (`--max-warnings 0`) where a file now imports both `contracts` and `format` from `@tesserix/homechef-shared` on two lines — merge them into one `import { ... } from "@tesserix/homechef-shared"`. Do NOT re-create the local file.

- [ ] **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "refactor(web): consume HomeChef contracts from @tesserix/homechef-shared"
```

---

### Task 3: Repoint `apps/mobile` to the shared contracts (adopts web shapes) and delete its local file

The semantic step: mobile now uses the web-canonical types. The typecheck gate proves the dropped `ReviewRow`/`MealPlanRow` fields were unused.

**Files:**
- Modify: `apps/mobile/package.json` (dep already present from Phase 1a; add if missing)
- Modify: the 4 mobile files importing local `contracts`
- Delete: `apps/mobile/lib/contracts.ts`

- [ ] **Step 1: Confirm the workspace dep exists**

Run:
```bash
grep '@tesserix/homechef-shared' apps/mobile/package.json || echo "MISSING — add it to dependencies"
```
If missing, add `"@tesserix/homechef-shared": "workspace:*"` to `apps/mobile/package.json` dependencies.

- [ ] **Step 2: Repoint every mobile import of the local contracts module**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
grep -rl "lib/contracts\|/contracts\"" apps/mobile/app apps/mobile/lib --include='*.ts' --include='*.tsx' \
  | grep -v 'lib/contracts.ts' \
  | xargs sed -i '' -E "s#['\"](@/lib/contracts|(\.{1,2}/)+(lib/)?contracts)['\"]#\"@tesserix/homechef-shared\"#g"
grep -rn "from ['\"].*lib/contracts['\"]\|from ['\"]\.[^'\"]*contracts['\"]" apps/mobile/app apps/mobile/lib --include='*.ts' --include='*.tsx' | grep -v 'lib/contracts.ts' || echo "no local contracts imports remain"
```
Expected: "no local contracts imports remain". (`apps/mobile/lib/hooks.ts` is the main importer, plus `chefs.tsx`, `support.tsx`, `cancellations.tsx`, `delivery-failures.tsx`.)

- [ ] **Step 3: Delete the local file**

```bash
git rm apps/mobile/lib/contracts.ts
```

- [ ] **Step 4: Build the package, then verify mobile typecheck (the safety proof) + Metro bundle**

Run:
```bash
pnpm install
pnpm --filter @tesserix/homechef-shared build
pnpm --filter mobile typecheck
```
Expected: `tsc --noEmit` exits 0. This PROVES mobile does not use the dropped `ReviewRow.rating`/`text` or `MealPlanRow.mealCount`/`daysPerWeek`/`pricePerMeal`/`totalPrice`, and that every type mobile references exists in the web-canonical superset. **If it fails on a dropped field**, that field was actually used by mobile — STOP and report (this means the drift reconciliation needs the Go API to decide, not a silent field re-add).

Then the Metro bundle smoke:
```bash
cd apps/mobile && npx expo export --platform ios --output-dir /tmp/mobile-contracts-smoke 2>&1 | tail -12
rm -rf /tmp/mobile-contracts-smoke
```
Expected: bundles with NO `Unable to resolve module @tesserix/homechef-shared` error.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile pnpm-lock.yaml
git commit -m "refactor(mobile): consume HomeChef contracts from @tesserix/homechef-shared (adopt canonical web shapes)"
```

---

### Task 4: Full-workspace verification (incl. Docker)

**Files:** none (verification).

- [ ] **Step 1: Single-sourcing check**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
test ! -f apps/web/lib/products/homechef/contracts.ts && test ! -f apps/mobile/lib/contracts.ts \
  && echo "both local contracts.ts deleted" || echo "STILL PRESENT"
ls packages/homechef-shared/src/contracts.ts
```
Expected: "both local contracts.ts deleted"; the shared file exists.

- [ ] **Step 2: Clean install + full turbo run**

Run:
```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules .turbo
pnpm install --frozen-lockfile
pnpm run build && pnpm run typecheck && pnpm run test
pnpm --filter mobile typecheck
```
Expected: `--frozen-lockfile` in sync; turbo builds the package before apps; web build + all typechecks + tests green; mobile typecheck green.

- [ ] **Step 3: Web Docker build (prod artifact proof)**

Run:
```bash
docker build --platform linux/amd64 -t tesserix-home:contracts-test .
```
Expected: both stages complete with no `Module not found` for `@tesserix/homechef-shared` (the Phase 1a Dockerfile already builds the package before web; contracts ride along in the same `dist`). Optionally run the container and confirm HTTP 200, then `docker rmi tesserix-home:contracts-test`.

- [ ] **Step 4: Commit any lockfile update**

```bash
git add pnpm-lock.yaml
git diff --cached --quiet || git commit -m "chore: lockfile after contracts extraction"
```

---

### Task 5: Ship

- [ ] **Step 1: Push and open a PR**

```bash
git push -u origin <branch>
```
(Branch = `feat/shared-contracts`, based on `feat/shared-format` if stacking on #52, else off `main` after #52 merges.) CI runs install/lint/test only (no image build/push on branch pushes). Open a PR to `main` (or to `feat/shared-format` if stacked).

- [ ] **Step 2: PR notes**

Call out the one behavioral decision: mobile adopts the web-canonical `ReviewRow`/`MealPlanRow` shapes; mobile's stale `rating`/`text` and `mealCount`/`daysPerWeek`/`pricePerMeal`/`totalPrice` are dropped, verified unused (no mobile reviews/meal-plans screen). If a mobile reviews/meal-plans screen is later built, it uses the canonical (real-API) shape.

## Notes for the executor
- This is a large VERBATIM file move (960 lines) — do NOT hand-retype it; `cp` the web file into the package (Task 1 Step 1). The web file is pure (no imports), so it needs no edits.
- The mobile typecheck in Task 3 Step 4 is the load-bearing safety check. Trust it: green = the dropped fields were genuinely unused. Red on a dropped field = escalate (needs Go-API arbitration), do not silently re-add.
- Update `packages/README.md` if it lists deferred de-dup targets — contracts + format are now done; the remaining deferred items are the HttpClient port / api transports.
```
