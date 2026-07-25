# Session Handoff — Mobile Admin Parity (2026-07-25)

## Current state: shipped to prod
`main` = `0b8648c` (all pushed). Working tree clean. Pushing `main` rebuilds/redeploys the web `company` image (mobile changes are a no-op for web, but it cycles prod — that's the accepted workflow here).

### What's DONE this session (mobile app, `apps/mobile`)
1. **Mobile Google sign-in** — wired + deployed + validated on the sim to a real signed-in session. Backend `GOOGLE_MOBILE_CLIENT_IDS` set in `tesserix-k8s` `company/values.yaml` (live). API base is `https://tesserix.app` (NOT `home.tesserix.app` — that's unrouted → Istio 403).
2. **Platform section** — read + key-actions parity (4 new screens: Support Analytics, Notifications Log, Lead Templates, Observability Trace detail). Shipped `41da33c`.
3. **Mark8ly area — COMPLETE** (both slices):
   - Slice A (`3570197`): hub + Overview + Leads (list + detail: status/star/activity/send-email) + Tenants (list + status-change + read-only detail).
   - Slice B (`0b8648c`): Subscriptions, Onboarding funnel, Audit logs, Email templates (+ Send-test); all 7 hub items live.

### What's LEFT (the parity effort continues by product area)
- **HomeChef** — the big one (~24 missing screens; some data hooks already exist in `apps/mobile/lib/hooks.ts`). **Decompose into sub-slices** before building (like Mark8ly was). Screens on web: analytics, approvals, audit-logs, campaigns, cancellations, chefs, delivery, delivery-intelligence, fssai, loyalty, meal-plans, messaging, orders, payment-gateway, payout-queue/setup/payouts, platform-settings, promos, refund-payouts, reviews, staff, support, users, wallets, winback. HomeChef mobile screens already exist for a few (index, cancellations, chefs, orders, support, delivery-failures). HomeChef data goes through the `hc` gateway client (`/api/admin/apps/homechef/gw/...` → HMAC → Go `/api/v1/admin/...`), which lives in a separate Go repo.
- **DevAI** — 1 screen (trivial/low value).
- **Device smoke tests still PENDING** for Platform + both Mark8ly slices — I could never run them because the sim's session needs the user's real Google login (their step). typecheck + multi-stage code review passed on everything; the one thing unverified is live-render against prod data.

## How the work was done (repeat this process)
Per-area cycle: **superpowers:brainstorming** (scope + decompose) → write spec to `docs/superpowers/specs/` → **superpowers:writing-plans** (concrete no-placeholder plan to `docs/superpowers/plans/`) → **superpowers:subagent-driven-development** (fresh implementer subagent per task + a task-review subagent per task + a whole-branch review at the end). Ledger at `.superpowers/sdd/progress.md`. Extract exact API shapes via a general-purpose agent BEFORE writing the plan (so tasks have real types, not placeholders).

User preferences: commit directly to `main`, single-line commit messages, no signatures. Always subagent-driven for plans (don't ask inline-vs-subagent).

## Mobile-specific gotchas (all learned the hard way)
- **Rebuild the shared package before mobile typecheck**: `pnpm --filter @tesserix/homechef-shared build` — else `tsc` reports missing `@tesserix/homechef-shared` format exports (stale dist). Then `cd apps/mobile && npx tsc --noEmit` (the only gate — NO RN unit-test runner exists).
- **Metro on port 8082** (`RCT_METRO_PORT=8082 npx expo start --dev-client --port 8082`) — 8081 is taken by the user's `postiz-pg-admin` Docker container. Dev build required (expo-dev-client). Reconnect the app: `xcrun simctl openurl <UDID> "exp+tesserix-admin://expo-development-client/?url=http://localhost:8082"`. Sim UDID: `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`. `idb` at `~/Library/Python/3.9/bin/idb` for taps.
- **SDK 56 native versions are mandatory** (RN 0.85.3, not 0.86) — mismatch → Hermes JSI launch crash. Run `expo-doctor` if it crashes on boot. (Already aligned.)
- **expo-router typedRoutes**: `router.push` to a route whose file doesn't exist yet (forward-ref, e.g. list→detail built in separate tasks) must be cast `... as never` (codebase convention; the hub already does it).
- **plat client**: `apps/mobile/lib/api.ts` — `plat.get(path, params)` / `plat.post(path, body)` prefix `/api/admin`, add bearer + `Origin` (CSRF). `plat.post` has NO params arg → put query params in the path string. `hc` client is the HomeChef HMAC gateway.
- **Formatters**: `formatPct(x)` takes 0..100; `formatRatioPct(x)` takes 0..1. Wire dates are ISO strings.
- **Data layer**: Platform → `lib/platform-hooks.ts`/`lib/platform-contracts.ts` (`pk` keys). Mark8ly → `lib/mark8ly-hooks.ts`/`lib/mark8ly-contracts.ts` (`mk` keys). HomeChef → `lib/hooks.ts` (`hc` client + `qk` keys). Kit components in `components/kit.tsx`; theme in `lib/theme.ts` (`usePalette`/`space`/`radius`/`text`).
- **Nav**: products via the Apps tab (`app/(tabs)/apps.tsx`, `live` flag per product); Platform via the Platform tab. Product hub pattern: `app/<product>/_layout.tsx` (Stack, headerShown:false) + `index.tsx` (SECTIONS hub with `live` flags → "Soon" badge when false).

## Verify prod anytime
```
kubectl -n tesserix get deploy company -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="GOOGLE_MOBILE_CLIENT_IDS")].value}{"\n"}'
```
Memory (`MEMORY.md` + `mobile_admin_app.md`) carries the durable facts.
