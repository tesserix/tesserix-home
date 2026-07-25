# Mobile Admin — Mark8ly Slice A: Hub + Lifecycle Actions

**Date:** 2026-07-25
**Status:** Approved design → ready for implementation plan
**Area:** `apps/mobile` (Expo/expo-router). Slice A of the Mark8ly product area (part of the larger web-admin→mobile parity effort; Platform section already shipped). Slice B (Subscriptions / Onboarding / Audit logs / templates) is a separate later cycle.

## Goal

Build the Mark8ly product hub into the mobile app with **read + key-actions parity** for the two lifecycle surfaces operators use on the go: **lead CRM** and **tenant status management**, plus a scalar **Overview**.

## Context

- Mark8ly is a product (like HomeChef), so it's navigated via the **Apps tab** (`app/(tabs)/apps.tsx`), and its screens live under `app/mark8ly/`, mirroring the HomeChef product-hub pattern (`app/homechef/_layout.tsx` = headerless `Stack`; `index.tsx` = sectioned hub of `ListRow`s with `live` flags).
- All Mark8ly endpoints are under `/api/admin/...`, reachable via the existing `plat` client (bearer + `Origin` CSRF header). No `plat` client changes, no backend changes.
- New data layer files: `apps/mobile/lib/mark8ly-hooks.ts` + `apps/mobile/lib/mark8ly-contracts.ts`, mirroring `platform-hooks.ts` / `platform-contracts.ts` (TanStack Query, `pk`-style key factory, types mirrored verbatim from the web route/handler sources cited below).
- `product=mark8ly` is a hardcoded path segment in the product-scoped hooks.

## Scope — In

### Navigation
- `app/mark8ly/_layout.tsx` — `Stack`, `headerShown: false` (copy `homechef/_layout.tsx`).
- `app/mark8ly/index.tsx` — sectioned hub. Sections/items (route, `live`):
  - **Overview** → `/mark8ly/overview` (live)
  - **Growth**: Leads → `/mark8ly/leads` (live)
  - **Tenants & billing**: Tenants → `/mark8ly/tenants` (live)
  - (Slice B items — Onboarding, Subscriptions, Audit logs, Email templates — listed as `live: false` "Soon" stubs so the IA is visible.)
- `app/(tabs)/apps.tsx` — flip the `mark8ly` entry to `live: true`, route `/mark8ly` (currently a stub). Do not change the HomeChef entry.

### Screen 1 — Overview (`app/mark8ly/overview.tsx`, read-only)
- Endpoints: `GET /api/admin/dashboard` (business KPIs), `GET /api/admin/apps/mark8ly/revenue?days=30` (revenue), `GET /api/admin/apps/mark8ly/audit-logs?severity=critical&since_hours=24` (critical count from `summary.criticalLast24h`).
- **Do NOT use `/apps/mark8ly/kpis`** — it returns `{}` for mark8ly; business KPIs come from `/dashboard` (`tenants.active`, `stores.total`, `leads.total`), exactly like the web `resolveKpiValue` fallback.
- Render (scalar `StatGrid`/`StatTile`/`StatCard` tiles only): Revenue (MRR, ARR, trials 30d, churn rate, active count), Business (active tenants, stores, leads), Critical events 24h. Optional compact email strip from revenue/metrics if trivially available.
- **Defer**: CPU/mem/pods sparklines, cost breakdown stack, `/apps/mark8ly/metrics` entirely.

### Screen 2 — Leads list (`app/mark8ly/leads/index.tsx`, read + filters)
- Endpoint: `GET /api/admin/leads?status=&q=&starred=` → `{ leads: Lead[] }`.
- Render: a card/`ListRow` per lead (name or company or handle, contact line, status badge, star indicator, owner chip, activity count). Controls: a `SearchField` (→ `q`), a status `FilterChips` row, a "Starred" toggle chip.
- Tap a lead → `/mark8ly/leads/{id}`.
- **Defer**: the 14-column table, min-followers/min-posts/country/source multi-band filters, and the CSV/JSON **Import** drawer entirely.

### Screen 3 — Lead detail (`app/mark8ly/leads/[id].tsx`, read + 4 actions)
- **No `GET /api/admin/leads/{id}` endpoint exists.** Source the `Lead` object from the leads-list query cache by id (run the same `useLeads` query — it returns cached data instantly when arriving from the list; the user always reaches detail via the list). Activities are fetched separately.
- Endpoints:
  - `GET /api/admin/leads/{id}/activities` → `{ activities: Activity[] }` (timeline)
  - `PATCH /api/admin/leads/{id}` `{ status }` — **change status**
  - `PATCH /api/admin/leads/{id}` `{ is_starred }` — **toggle star**
  - `POST /api/admin/leads/{id}/activities` `{ kind, body }` — **log activity** (kind default `'note'`)
  - `POST /api/admin/leads/{id}/send-email` `{ templateKey, idempotencyKey }` — **send email** (template picked from `GET /api/admin/lead-templates`; reuse the existing `useLeadTemplates` hook in `platform-hooks.ts`). Generate `idempotencyKey` client-side (e.g. `${id}-${Date.now()}`). Disable send for handle-only leads (no email).
- Render: identity header (name/company/contact/source), status picker (`FilterChips` of the known statuses) + star toggle, an activity timeline (list of `Activity` cards), an inline activity composer (`TextInput` + Add, mirroring `announcements.tsx`), and a "Send email" action that opens a template picker (list of published templates) → confirm → POST.
- Each mutation invalidates the leads-list key and (for activity/send) the activities key.
- **Owner-assign is deferred** (no clear owner source on mobile).

### Screen 4 — Tenants list (`app/mark8ly/tenants/index.tsx`, read + status action)
- Endpoints: `GET /api/admin/tenants?status=` → `{ tenants: Tenant[] }`; `PATCH /api/admin/tenants/{id}` `{ status }` → `{ tenant }`.
- Render: `ListRow`/card per tenant (name, owner email, status badge, created). Status `FilterChips` (active/suspended/archived/all).
- **Key action — change status**: a per-tenant control (e.g. an action sheet / inline `FilterChips` of target statuses) that PATCHes `{ status }`, guarded by a confirm `Alert` before suspend/archive. Invalidate the tenants list on success.
- Tap → `/mark8ly/tenants/{id}`.

### Screen 5 — Tenant detail (`app/mark8ly/tenants/[id].tsx`, read-only)
- Endpoints: `GET /api/admin/tenants/{id}` (identity), `GET /api/admin/apps/mark8ly/tenants/{id}/billing` (subscription block). `/apps/mark8ly/tenants/{id}/metrics` optional (scalars only).
- Render: identity block (name/status/owner/created/id), subscription block (plan, status, trial days remaining + conversion likelihood, lifetime revenue, cancel-at-period-end). Optionally surface the status-change action here too (reuse the list PATCH).
- **Defer**: activity sparklines, storage/row-count details beyond a couple of scalars, cost-share proxy %, margin card, plan-history timeline.

### Data layer (`lib/mark8ly-hooks.ts` + `lib/mark8ly-contracts.ts`)
- Contracts (mirror verbatim from the cited sources): `Lead`, `Activity`, `Tenant`, `TenantBillingResponse` (subset used), `RevenueData`, and reuse `PlatformDashboard` from `platform-contracts.ts` for `/dashboard`.
- Hooks: `useMark8lyOverview` (or per-endpoint: `useRevenue`, `useCriticalCount`, reuse `usePlatformDashboard`), `useLeads(filters)`, `useLeadActivities(id)`, `useSetLeadStatus(id)`, `useToggleLeadStar(id)`, `useLogLeadActivity(id)`, `useSendLeadEmail(id)`, `useTenants(status)`, `useSetTenantStatus(id)`, `useTenant(id)`, `useTenantBilling(id)`. Reuse `useLeadTemplates` from `platform-hooks.ts`.
- Query-key factory `mk` (parallel to `pk`). Mutations invalidate the relevant list/detail keys.

## Data-contract sources (mirror exact field names; do not guess)
- `Lead`, `Activity` → `apps/web/app/admin/apps/mark8ly/leads/page.tsx` (+ the `/api/admin/leads` route handler for the `{leads}` wrapper).
- `Tenant` → `apps/web/app/admin/apps/mark8ly/tenants/page.tsx` + `apps/web/app/api/admin/tenants/route.ts` + `[id]/route.ts` (PATCH `{status}` → `{tenant}`).
- `RevenueData` → `apps/web/components/admin/billing/revenue-section.tsx`; `TenantBillingResponse` → `apps/web/app/api/admin/apps/[product]/tenants/[id]/billing/route.ts`.
- `PlatformDashboard` → already in `apps/mobile/lib/platform-contracts.ts`.
- Lead statuses / activity kinds: enumerate from the web page's constants.

## Scope — Out (deferred)
- Slice B pages: Subscriptions, Onboarding funnel, Audit logs (full), notification template list/editor.
- Leads: CSV/JSON import, wide table, multi-band filters, owner-assign.
- Metrics sparklines, cost breakdown, margin/cost-share, plan-history timeline.
- Template HTML editing (Slice B, read-only + send-test only if built).

## Verification
1. **Endpoint smoke-check first**: the Mark8ly endpoints are bearer-reachable (Platform screens proved the `plat` path) but not yet exercised — confirm 200s for `/apps/mark8ly/revenue`, `/leads`, `/leads/{id}/activities`, `/tenants`, `/apps/mark8ly/tenants/{id}/billing` before building UI. Confirm the mutations (`PATCH /leads/{id}`, `PATCH /tenants/{id}`, `POST /leads/{id}/activities`, `POST /leads/{id}/send-email`) return 200 (CSRF `Origin` header is already set by the `plat` interceptor).
2. Each screen smoke-tested on the iPhone 17 Pro sim against prod: real data renders; each action (lead status/star/activity/send-email; tenant status change) succeeds and the list reflects it.
3. `cd apps/mobile && npx tsc --noEmit` clean (rebuild `@tesserix/homechef-shared` first if it reports missing format exports); no new expo-doctor issues.
4. Match sibling conventions (kit components, theme tokens, TanStack hooks, local `StyleSheet` for text inputs like `announcements.tsx`, pull-to-refresh).

## File change list
**New:**
- `apps/mobile/app/mark8ly/_layout.tsx`
- `apps/mobile/app/mark8ly/index.tsx`
- `apps/mobile/app/mark8ly/overview.tsx`
- `apps/mobile/app/mark8ly/leads/index.tsx`
- `apps/mobile/app/mark8ly/leads/[id].tsx`
- `apps/mobile/app/mark8ly/tenants/index.tsx`
- `apps/mobile/app/mark8ly/tenants/[id].tsx`
- `apps/mobile/lib/mark8ly-hooks.ts`
- `apps/mobile/lib/mark8ly-contracts.ts`

**Modified:**
- `apps/mobile/app/(tabs)/apps.tsx` (mark8ly → live)

## Non-goals / guardrails
- No new backend/API routes; the web `/api/admin/*` handlers are the shared backend.
- No `plat` client changes; all calls use the existing `/api/admin` prefix with `product=mark8ly` hardcoded where product-scoped.
- Keep files focused (one screen per file, ~100–200 lines; lead detail may run larger given 4 actions — split helper components if it exceeds ~250).
