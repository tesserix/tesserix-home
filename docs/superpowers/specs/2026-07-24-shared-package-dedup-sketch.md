# Sketch: `packages/shared` de-duplication (web ↔ mobile)

**Date:** 2026-07-24
**Status:** Design sketch (not yet an executable plan). Follows the monorepo restructure (PR #47).
**Prereq:** PR #47 (monorepo restructure) merged.

## Why now — the drift is already real

The restructure deferred de-dup, but the two apps already keep **hand-synced copies** of the HomeChef admin domain layer, and those copies have **begun to rot**. Evidence (from a read-only comparison of `apps/web/lib/products/homechef/` vs `apps/mobile/lib/`):

- `format.ts` — **byte-identical** in both apps.
- `contracts.ts` — same header ("single source of truth… kept in lockstep"), but web is a superset and several shared types have **diverged**:
  - `ReviewRow`: mobile `rating`/`text?`/`comment?` vs web `overallRating`/`comment?` (field-name mismatch)
  - `MealPlanRow`: mobile `mealCount/daysPerWeek/pricePerMeal/totalPrice` vs web `total`/`days?: MealPlanDayRow[]` (structurally different)
  - `PendingPayout`: web adds `netPayout`, `hasOpenIssue`, `aggType: "group-order"`; mobile lacks them
  - `OrderIssue`: web adds `photoUrls?`; mobile lacks it
  - `ApprovalRequest`: web adds `reminderCount`/`lastRemindedAt`/`escalatedAt`; mobile lacks them

There is **no real single source of truth today** — just a copy that's silently mismatching against the same Go API. That is the bug this work fixes.

## What is genuinely shareable (and what is not)

React and React Native can't share UI, and the two apps use different auth transports (web: httpOnly JWE cookie + Next middleware + SSR session exchange; mobile: `expo-secure-store` bearer + id-token exchange). So the shareable surface is **pure TypeScript only**:

| Source | Bucket | Action |
|---|---|---|
| `contracts.ts` (types + `CANCEL_REASONS`, `parseSegment`, const tables) | **PURE-TS shareable** | Extract — biggest win |
| `format.ts` (`formatINR`, `formatDateTime`, …) | **PURE-TS shareable** (byte-identical) | Extract verbatim |
| Gateway path prefix (`/api/admin/apps/homechef/gw`) + the `{get,put,post,del}<T>` client *interface* | **PURE-TS shareable** (as a port) | Extract as `HttpClient` interface + path constants |
| `api.ts`/`client.ts` transport bodies (axios+secure-store vs fetch+cookie) | **Platform-specific** | Stay per-app; each implements the port |
| `hooks.ts` (react-query) vs web's inline SWR | **Platform-specific** (React + lib-divergent) | Out of scope |
| `theme.ts` (`react-native` import, RN `TextStyle`) | **Platform-specific** | Out of scope (raw hex could be a token-only carve-out later) |
| `auth.tsx` (id-token→bearer) vs web JWE cookie | **Platform-specific** | Out of scope (only `AdminUser` shape is trivially shareable) |

Note: `zod` is a dep of web but **not** mobile, and the HomeChef contracts are plain interfaces (no runtime validation) in both. Keep the shared contracts as structural TS to start — adding zod would pull a new runtime dep into mobile, a deliberate later choice.

## Proposed shape

One config-... no — one **pure-TS** package (sibling to the existing config-only packages):

```
packages/homechef-contracts/         name: @tesserix/homechef-contracts
├── package.json                     (no runtime deps; type: module; tsup or tsc build → dist/)
├── src/
│   ├── contracts.ts                 the reconciled superset of admin DTO types + const tables
│   ├── format.ts                    the shared formatters (verbatim)
│   ├── http-port.ts                 `HttpClient` interface + GATEWAY_PREFIX constants (no transport)
│   └── index.ts                     re-exports
```

- **Web** replaces `apps/web/lib/products/homechef/{contracts,format}.ts` with imports from `@tesserix/homechef-contracts`; its `client.ts` implements `HttpClient` with fetch+cookie.
- **Mobile** replaces `apps/mobile/lib/{contracts,format}.ts` with imports; its `api.ts` implements `HttpClient` with axios+secure-store.
- Package name is HomeChef-scoped on purpose — it's HomeChef admin domain types, not generic platform types. A generic `@tesserix/shared` can come later if a second domain needs sharing.

Build/consumption: workspace dep `"@tesserix/homechef-contracts": "workspace:*"`. Since these are consumed by a Next build and a Metro build, ship compiled `dist/` (tsup) rather than raw TS, OR add the package to Next `transpilePackages` and Metro's watchFolders — decide during planning (tsup/dist is the lower-friction default and matches how the design-system ships).

## The hard part: reconciling the drift before extracting

Extraction can't be a blind copy — the drifted types need a **canonical decision per field**, verified against the actual Go API response, not against either app's guess. For each drifted type (`ReviewRow`, `MealPlanRow`, `PendingPayout`, `OrderIssue`, `ApprovalRequest`):
1. Check the Go source (or a live `/admin/*` response) for the real field names/shape.
2. Pick the canonical shape; update whichever app was wrong.
3. Only then move the type into the shared package.

This is why Phase 1 is "contracts," not "move files" — the value is in ending the drift correctly, and a careless extract would freeze a wrong shape into both apps.

## Suggested phasing (each independently shippable)

- **Phase 1 — `format.ts` + `contracts.ts`** (biggest win). Reconcile the 5 drifted types against the Go API, extract the superset, switch both apps to import it. Verify: `pnpm --filter web build/typecheck/test`, `pnpm --filter mobile typecheck`, and a manual smoke of the affected HomeChef admin screens on both apps.
- **Phase 2 — `HttpClient` port + gateway path constants.** Define the interface + constants in the package; refactor each app's transport to implement it. Lower value, more churn — do only if Phase 1 proves the pattern.
- **Phase 3 (optional) — token-only theme carve-out.** Extract raw hex palette as a pure-TS token map if web/mobile color drift becomes a problem. Low priority.

**Explicitly out of scope:** unifying data-fetching hooks (would force SWR-vs-react-query standardization), auth transports, and any UI.

## Risks / open questions (resolve during planning)

- **Shared-package build/consumption** under both Next (Turbopack) and Metro — tsup `dist/` vs `transpilePackages`/watchFolders. Metro + workspace packages needs the `.npmrc` hoisted linker already in place (good) plus possibly `metro.config.js` `watchFolders`.
- **Canonical field decisions** need the Go API as the arbiter — may need a `mp`/HomeChef backend reference or a live token to inspect responses.
- **Mobile gaining fields it doesn't render** — importing the superset is fine (extra fields are ignored), but confirm no `noUncheckedIndexedAccess`/exactOptional friction in mobile's stricter tsconfig.

## Next step

When ready, turn Phase 1 into a full task-by-task implementation plan (brainstorm → plan → subagent execution), gated on PR #47 being merged. Do **not** bundle this into PR #47 — that PR is restructure-only and behavior-neutral by design.
