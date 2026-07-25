# Mobile Admin — Finish the Platform Section (read + key actions)

**Date:** 2026-07-25
**Status:** Approved design → ready for implementation plan
**Area:** `apps/mobile` (Expo/expo-router). First slice of the larger "web admin → mobile" parity effort. Later slices (HomeChef, Mark8ly, DevAI) are separate spec→plan cycles.

## Goal

Bring the mobile app's **Platform** section (tesserix-owned admin — the web `apps/web/app/admin/*` routes, excluding `admin/apps/*`) to **read + key-actions parity** with the web admin. "Key actions" = the high-value mutations an admin does on the go; low-value bulk/config editing is deferred.

## Context: the section is already ~85% built

A parity audit found 13 of the Platform screens already DONE on mobile (search/users, tickets + detail, announcements, service health, uptime, observability overview, databases, custom-domains + verify/refresh, outbox, erasure, break-glass, user identity). The mobile data layer is `apps/mobile/lib/api.ts` (`plat` client → `/api/admin/*`, bearer + `Origin` CSRF header) with hooks in `apps/mobile/lib/platform-hooks.ts` (`pk` query keys) and types in `apps/mobile/lib/platform-contracts.ts`. expo-router auto-registers screen files under `apps/mobile/app/platform/` — no manual route list in `_layout.tsx`.

Therefore this slice is small and additive: **3 new screens + 1 trace-detail screen + nav wiring + a data-layer extension + one cleanup.**

## Scope

### In scope

**Screen 1 — Support Analytics** (`app/platform/analytics-support.tsx`, read-only)
- Web source of truth: `apps/web/app/admin/analytics/support/page.tsx`. Endpoint: `GET /api/admin/analytics/support`.
- Render: the 8 KPI tiles + the three "by status / by reason / by tenant" breakdowns rendered as **ranked lists** (label + count + share), NOT bar charts.
- Behavior: `refetchInterval: 30_000` (matches web poll). Loading/error/empty states per existing screens.

**Screen 2 — Notifications Log** (`app/platform/notifications-log.tsx`, read-only)
- Web source of truth: `apps/web/app/admin/notifications/log/page.tsx`. Endpoint: `GET /api/admin/email-events?view=metrics|recent&product=&tenant=&window=`.
- Render: 6 KPI tiles (sent / delivered% / opens% / clicks / bounces / unsub) from `view=metrics`; recent-event **cards** (≤100) from `view=recent`. Drop the wide table.
- Filters: product / tenant / window as chips (reuse the chip pattern from `uptime.tsx`/`erasure.tsx`).

**Screen 3 — Lead Templates** (`app/platform/lead-templates.tsx`, read-only list + **Send test**)
- Web source of truth: `apps/web/app/admin/notifications/lead-templates/page.tsx` (+ `[key]/page.tsx` for shapes). Endpoints: `GET /api/admin/lead-templates`; `POST /api/admin/lead-templates/{key}/test-send`.
- Render: template cards (label / product / subject / status badge). Per-card **"Send test"** action → prompt for an email address (`Alert.prompt` iOS / a small modal input) → POST → success/error toast.
- HTML/text body **editing is deferred** (poor phone fit — raw-HTML editor + iframe preview on web). View-only fields are acceptable; no body editor.

**Screen 4 — Observability Trace detail** (`app/platform/trace/[id].tsx`, read-only)
- Web source of truth: the trace-explorer drill-down in `apps/web/app/admin/observability/page.tsx`. Endpoint: `GET /api/admin/observability/trace?id=`.
- Render: trace header + spans as a **depth-indented list** (indent by span depth; show service/op, duration, status), NOT a horizontal waterfall.
- Wire-up: make the existing recent-trace rows in `app/platform/observability.tsx` tappable → `router.push('/platform/trace/{id}')`.

**Data layer** (`lib/platform-hooks.ts` + `lib/platform-contracts.ts`)
- Add hooks + `pk` keys: `usePlatformSupportAnalytics()`, `useNotificationLog(filters)`, `useLeadTemplates()`, `useSendLeadTestEmail(key)` (mutation), `useTrace(id)`.
- Add the corresponding response types to `platform-contracts.ts`, mirrored from each web API route's response shape (read the route handler + page to get exact fields). All endpoints sit under the existing `/api/admin` prefix — **no `plat` client changes**.

**Navigation** (`app/(tabs)/platform.tsx`)
- Add a **Notifications** group: "Notifications log" → `/platform/notifications-log`, "Lead templates" → `/platform/lead-templates` (both `live: true`).
- Add "Support analytics" → `/platform/analytics-support` under the **Support** group (`live: true`).
- Trace detail is reached from observability, not the index.
- Leave the existing "Audit logs" item as `live: false` ("Soon") — out of scope (per-product, not platform-wide).

**Cleanup** (`lib/api.ts`)
- Fix the stale fallback default `const BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://home.tesserix.app'` → `'https://tesserix.app'` (the fallback host is the unrouted one that returns Istio 403; env already overrides it, but the default should be correct).

### Optional polish (include only if it falls out cheaply during implementation)
- Dashboard tab (`(tabs)/index.tsx`): add a compact leads-by-status breakdown (data already in `/dashboard`).
- Tickets (`platform/tickets.tsx`): expose priority/product filter chips (the `useTicketsList` hook already accepts them).
- Health (`platform/health.tsx`): namespace filter chips.

### Out of scope (this slice)
- **Settings → Stripe payment-key config**: sensitive secret entry on a phone, and it writes to `/api/subscriptions/admin/settings/stripe*` which is **outside** the `plat` client's `/api/admin` prefix (would need a new client). Defer.
- Full lead-template **HTML/text body editing** and live preview.
- Observability throughput/latency **charts**, status donut, and the span **waterfall** (list form only).
- Dashboard **funnel/donut charts**.
- **Leads / tenants CRUD** — belongs to the Mark8ly slice, not Platform.

## Data contracts

For each new endpoint, the implementer must read the web route handler + page to mirror the exact response shape into `platform-contracts.ts` (do not guess field names):
- `GET /api/admin/analytics/support` → `apps/web/app/api/admin/analytics/support/route.ts`
- `GET /api/admin/email-events` (`view=metrics` and `view=recent`) → `apps/web/app/api/admin/email-events/route.ts`
- `GET /api/admin/lead-templates` and `POST /api/admin/lead-templates/[key]/test-send` → `apps/web/app/api/admin/lead-templates/route.ts` + `[key]/test-send/route.ts`
- `GET /api/admin/observability/trace` → `apps/web/app/api/admin/observability/trace/route.ts`

## Verification

1. **Endpoint smoke-check first:** these 4 endpoints are structurally bearer-reachable (PR #51) but not yet exercised over bearer. Before building each screen, confirm a `200` from the mobile session (on the sim, or by hitting `https://tesserix.app/api/admin/...` with a valid bearer). If any returns non-200, stop and diagnose before building UI on it.
2. Each new screen smoke-tested on the iPhone 17 Pro sim against prod: renders real data, key action (Send test) works, loading/error/empty states behave.
3. `cd apps/mobile && npx tsc --noEmit` clean; `npx expo-doctor` shows no new issues.
4. Match existing screen conventions: `Screen`/`ScreenHeader`/`SectionLabel`/`ListRow`/`Badge` from `components/kit`, theme tokens from `lib/theme`, TanStack Query hooks, pull-to-refresh where the siblings have it.

## File change list

**New:**
- `apps/mobile/app/platform/analytics-support.tsx`
- `apps/mobile/app/platform/notifications-log.tsx`
- `apps/mobile/app/platform/lead-templates.tsx`
- `apps/mobile/app/platform/trace/[id].tsx`

**Modified:**
- `apps/mobile/lib/platform-hooks.ts` (5 hooks + keys)
- `apps/mobile/lib/platform-contracts.ts` (response types)
- `apps/mobile/app/(tabs)/platform.tsx` (nav: Notifications group + Support analytics)
- `apps/mobile/app/platform/observability.tsx` (recent-trace rows → tap to trace detail)
- `apps/mobile/lib/api.ts` (fallback host cleanup)
- Optional: `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/app/platform/tickets.tsx`, `apps/mobile/app/platform/health.tsx`

## Non-goals / guardrails
- No new backend/API routes — the web `/api/admin/*` handlers are the shared backend and already exist.
- No `plat` client changes; all new calls use the existing `/api/admin` prefix.
- Keep files focused (one screen per file, ~100–200 lines like siblings).
