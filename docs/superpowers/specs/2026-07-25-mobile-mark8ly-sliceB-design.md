# Mobile Admin — Mark8ly Slice B: Read-Only Reporting + Template Send-Test

**Date:** 2026-07-25
**Status:** Approved design → ready for implementation plan
**Area:** `apps/mobile`. Slice B of the Mark8ly product area (Slice A — hub + Overview + Leads + Tenants — already shipped, `3570197`). Completes the Mark8ly hub by making the 4 remaining "Soon" items live.

## Goal

Add the 4 read-only reporting screens to the Mark8ly section — **Subscriptions, Onboarding funnel, Audit logs, Email templates** — plus one action: **Send-test** on a template. Brings the Mark8ly hub to fully live.

## Context

- Extends the Slice A data layer: add hooks to `apps/mobile/lib/mark8ly-hooks.ts` (`mk` key factory) and types to `apps/mobile/lib/mark8ly-contracts.ts`. All endpoints reachable via the existing `plat` client; `product='mark8ly'` hardcoded on `/apps/mark8ly/*` routes. No `plat`/backend changes.
- Screens live under `apps/mobile/app/mark8ly/` and follow the Slice A / Platform conventions (Screen/ScreenHeader/BackButton, StatGrid/StatTile, Card, FilterChips, ListRow, EmptyState/LoadingRows, theme tokens, `@tesserix/homechef-shared` formatters, whole-row `Pressable` for tappable cards, `router.push(... as never)` for forward-ref routes though these screens mostly deep-link to the already-existing tenant detail).
- The hub (`app/mark8ly/index.tsx`) already lists these 4 as `live: false`; this slice flips them to `live: true` and creates the screens.

## Scope — In

### Screen 1 — Subscriptions (`app/mark8ly/subscriptions.tsx`, read-only)
- Endpoint: `GET /api/admin/apps/mark8ly/subscriptions?filter=all|active|trial|past_due|cancelled` → `SubscriptionsListResponse`.
- Render: summary `StatGrid` (total MRR, active, trial, past-due, cancelled-this-month) + `FilterChips` (all/active/trial/past_due/cancelled) + a card per subscription (tenant name, plan badge, status, MRR, trial-days/dunning if present). Cards deep-link to the existing `/mark8ly/tenants/{tenantId}` detail.
- **Defer**: column sorting.

### Screen 2 — Onboarding funnel (`app/mark8ly/onboarding.tsx`, read-only)
- Endpoint: `GET /api/admin/apps/mark8ly/onboarding?status=in_flight|completed|abandoned|all` → `OnboardingResponse`.
- Render: funnel KPI tiles (in-flight, email-verified, completed, abandoned, median time-to-complete, 24h started/completed) + status `FilterChips` + a card per session (business name, email, status, verified/completed indicators, idle time). Sessions with a `tenant_id` deep-link to the tenant detail.

### Screen 3 — Audit logs (`app/mark8ly/audit-logs.tsx`, read-only)
- Endpoint: `GET /api/admin/apps/mark8ly/audit-logs?severity=&since_hours=` → `AuditLogsResponse` (uses `summary.criticalLast24h` + `rows`).
- Render: a critical-24h `StatTile` + a severity `FilterChips` row + a card per audit event (action, resource type/id, actor email, severity badge, relative time); tap a card to expand its `metadata` (toggle showing the JSON as text). 
- **Defer**: the full multi-facet filters (action/resource-type/actor dropdowns) — severity filter only.

### Screen 4 — Email templates (`app/mark8ly/templates.tsx`, read-only list + Send-test)
- Endpoints: `GET /api/admin/email-templates?database=platform_api|marketplace_api` → `{ database, templates: TemplateRow[] }`; `POST /api/admin/email-templates/{key}/test-send?database=...` `{ to }` (vars omitted → server auto-fills) → success/error.
- Render: a DB toggle (`FilterChips`: platform_api / marketplace_api) + a card per template (key/subject/status badge/version/updated). Per-card **"Send test"** → inline email `TextInput` (seeded with the operator's email from `useAuth`) → POST → success/error `Alert`. The `database` query param is **required** on both GET and POST — thread the selected DB through.
- **Defer**: HTML/text body editing + preview (poor phone fit).

### Data layer
- `mark8ly-contracts.ts`: add `SubscriptionsListResponse`/`SubscriptionRowItem`, `OnboardingResponse`/`OnboardingSessionRow`, `AuditLogsResponse`/`AuditEventRow`, `EmailTemplatesResponse`/`EmailTemplateRow`, `EmailTestSendResponse`. Mirror exact field names from the route handlers (see sources below).
- `mark8ly-hooks.ts`: add keys + hooks `useSubscriptions(filter)`, `useOnboarding(status)`, `useMark8lyAuditLogs(severity)`, `useEmailTemplates(database)`, `useTestSendEmailTemplate(key, database)` (mutation). All via `plat`.

### Navigation
- `app/mark8ly/index.tsx`: flip the 4 items `onboarding`, `subscriptions`, `audit-logs`, `templates` from `live: false` → `live: true` (routes `/mark8ly/subscriptions`, `/mark8ly/onboarding`, `/mark8ly/audit-logs`, `/mark8ly/templates`). Match the hub route strings to the created file names.

## Data-contract sources (mirror exact field names; do not guess)
- Subscriptions → `apps/web/app/api/admin/apps/[product]/subscriptions/route.ts` + `apps/web/lib/admin/use-billing.ts` (`SubscriptionsListResponse`, `SubscriptionRowItem`).
- Onboarding → `apps/web/app/api/admin/apps/[product]/onboarding/route.ts` (`OnboardingResponse`, `SessionRow`).
- Audit logs → `apps/web/app/api/admin/apps/[product]/audit-logs/route.ts` + `apps/web/lib/admin/use-audit.ts` (`AuditLogsResponse`, `AuditEvent`).
- Email templates → `apps/web/app/api/admin/email-templates/route.ts` (list, `database` param, `TemplateRow`) + `apps/web/app/api/admin/email-templates/[key]/test-send/route.ts` (POST body + response + error shapes).

## Scope — Out (deferred)
- Template HTML/text editing + preview (list + send-test only).
- Audit-logs full facet filters (action/resource/actor); wide tables → cards.
- Subscription/onboarding column sorting.
- Any mutations beyond template Send-test (all other screens read-only).

## Verification
1. **Endpoint smoke-check first**: confirm 200s for `/apps/mark8ly/subscriptions`, `/apps/mark8ly/onboarding`, `/apps/mark8ly/audit-logs`, `/email-templates?database=platform_api`, and the `POST /email-templates/{key}/test-send?database=...` before building UI on them.
2. Each screen smoke-tested on the iPhone 17 Pro sim against prod: real data renders; DB toggle switches templates; Send-test succeeds; onboarding/subscription cards deep-link to tenant detail.
3. `cd apps/mobile && npx tsc --noEmit` clean (rebuild `@tesserix/homechef-shared` first if it reports missing format exports); no new expo-doctor issues.
4. Match sibling conventions (kit, theme, hooks, whole-card `Pressable`, local `StyleSheet` for the template email input like `leads/[id].tsx`).

## File change list
**New:**
- `apps/mobile/app/mark8ly/subscriptions.tsx`
- `apps/mobile/app/mark8ly/onboarding.tsx`
- `apps/mobile/app/mark8ly/audit-logs.tsx`
- `apps/mobile/app/mark8ly/templates.tsx`

**Modified:**
- `apps/mobile/lib/mark8ly-contracts.ts` (5 response types + row types)
- `apps/mobile/lib/mark8ly-hooks.ts` (5 hooks + keys)
- `apps/mobile/app/mark8ly/index.tsx` (flip 4 hub items to live)

## Non-goals / guardrails
- No new backend/API routes; the web `/api/admin/*` handlers are the shared backend.
- No `plat` client changes; `product='mark8ly'` hardcoded where product-scoped; `database` param threaded on the email-templates routes.
- Keep files focused (one screen per file, ~100–180 lines).
