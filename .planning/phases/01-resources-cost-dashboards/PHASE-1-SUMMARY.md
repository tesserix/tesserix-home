# Phase 1 Summary — Resources + Cost Dashboards

**Status:** Functionally complete and live in production. ✅
**Closed:** 2026-05-01
**Surfaces live:** `https://tesserix.app/admin/apps/mark8ly` and `/admin/apps/mark8ly/tenants/{id}`

---

## What shipped

| Wave | Scope | Status |
|---|---|---|
| 0 | Infra: NetworkPolicy egress allow for `opencost`; `PROMETHEUS_URL` + `OPENCOST_URL` env in company chart | ✅ Live |
| 1 | Backend: `lib/products/configs.ts`, `lib/metrics/{prometheus,opencost,cost-proxy,product-metrics,tenant-metrics,window,email-events}.ts`, `lib/db/mark8ly-tenant-metrics.ts` | ✅ |
| 2 | API routes: `/api/admin/apps/[product]/metrics`, `/api/admin/apps/[product]/tenants/[id]/metrics`, GET on `/api/admin/tenants/[id]` | ✅ |
| 3 | UI primitives: `KpiTile`, `SparklineCard`, `CostBreakdownStack`, `TimeWindowPicker`, `RefreshControl`, `MetricsSection` | ✅ |
| 4 | Layouts: `<ProductOverviewLayout>`, `<TenantDetailLayout>`; refactored mark8ly Overview + tenant detail pages | ✅ |
| 5 | mark8ly send-site `custom_args` instrumentation | **Deferred** — see "Outstanding" below |
| 6 | Polish + a11y: `TooltipProvider` at admin layout, scoped admin error boundary, refresh toast, copy clarification | ✅ Partial |

---

## What works today

- **Mark8ly Overview** (`/admin/apps/mark8ly`):
  - Business KPIs (Active Tenants, Stores, Leads) — live counts via `/api/admin/dashboard`
  - Resources — CPU, memory, pods, DB size, replication lag, connections (Prometheus + CNPG metrics)
  - Cost — OpenCost allocation by namespace with breakdown stack
  - Email — placeholder zeros (lights up post-Wave 5 + Wave 1.5)
  - Time window picker (1h/24h/7d/30d), refresh control with toast
- **Tenant detail** (`/admin/apps/mark8ly/tenants/{id}`):
  - Identity (status, owner email, created, tenant ID)
  - Activity — sparklines for request rate + bandwidth (in/out), storage estimate, row counts (lights up post-DB-grants)
  - Email — placeholder zeros
  - Cost share — proxy = `product_cost × (50% requests + 30% storage + 20% egress)` with attribution breakdown and "Estimated" honesty pattern
- **Generalization**: Both pages take a `ProductConfig` prop. Adding HomeChef tomorrow is a config-only change in `lib/products/configs.ts`.
- **Resilience**: Per-section graceful degradation; one upstream failing doesn't take down the whole route.
- **Error handling**: Scoped admin error boundary keeps sidebar visible if a page throws.

## What's still empty (and why)

Three things require user-side ops or a separate effort:

1. **Tenant page row counts + storage estimate** show zeros until cross-DB SELECT grants run. One-time runbook execution against `mark8ly-postgres.marketplace`:
   ```sql
   GRANT SELECT ON marketplace.{stores, orders, products, customer_profiles}
   TO tesserix_admin;
   ```
   No code change required after; data hydrates on next refresh.

2. **Email metrics** show zeros until two pieces land:
   - **Wave 1.5** in `notification-service` repo: `email_events` table + `POST /webhooks/sendgrid` receiver with HMAC verify + `GET /internal/email-events/aggregate`. **Blocked on:** SendGrid Event Webhook signing key configured in SendGrid console and stored in GSM as `notification-service-sendgrid-webhook-secret`.
   - **Wave 5** instrumentation in mark8ly services (see below).

3. **Per-tenant email + request slice** stays at zero until Wave 5 lands `tenant_id` `custom_args` on outbound mark8ly sends.

---

## Wave 5 — explicitly deferred

`custom_args` instrumentation in mark8ly send sites is metadata-only and additive — but the surface area is wider than initially scoped:

| Service | Files affected |
|---|---|
| `mark8ly/services/platform-api` | `internal/notification/sendgrid.go` (single chokepoint), all `templates.go` Email constructors |
| `mark8ly/services/marketplace-api` | 4 separate SendGrid impls: `orderdoc/mailer.go`, `campaign/sendgrid_dispatcher.go`, `giftcard/mailer.go`, `shipping/labelmailer.go` |
| `mark8ly/services/otto` | `internal/mailer/sendgrid.go` |

Each needs:
1. `CustomArgs map[string]string` added to the local SendGrid request struct
2. `CustomArgs` plumbed from call sites (most have `tenant_id` in scope)
3. Per-service tests updated
4. Per-service deploy with smoke test (send a real email, verify `custom_args` appears in SendGrid Activity)

This is one focused PR per service, **not stuffed into Phase 1 closure** because the risk of breaking a live email flow outweighs the benefit of "metrics show numbers slightly sooner." Wave 1.5 + DB grants land first, *then* Wave 5 over a separate session.

---

## Phase 1 commits

| SHA | Repo | What |
|---|---|---|
| `8c99367` | tesserix-k8s | NetworkPolicy egress for opencost; `PROMETHEUS_URL` + `OPENCOST_URL` env |
| `ec8e110` | tesserix-home | Wave 1: types + Prom + OpenCost clients |
| `fb245b4` | tesserix-home | Wave 1: tenant DB metrics + cost-proxy |
| `373a40d` | tesserix-home | Wave 2: aggregators + API routes |
| `bd7dcf7` | tesserix-home | Wave 3: UI primitives |
| `bee51bc` | tesserix-home | Wave 4: layouts + page refactors |
| `da7c95e` | tesserix-home | Lint fix |
| `13b24d6` | tesserix-home | Wire Overview business KPIs to dashboard counts |
| `d03aeb7` | tesserix-home | Scoped admin error boundary |
| `f150266` | tesserix-home | TooltipProvider at admin layout |
| `ff71cce` | tesserix-home | Polish: refresh toast, copy clarification |

11 commits across 2 repos.

---

## Surprises and learnings

- **OpenCost was reachable but blocked at NetworkPolicy egress, not Istio AuthZ.** Initial assumption was mesh-level; the cluster's NetworkPolicy was the actual gate. Fixed with one chart edit.
- **CNPG metrics not yet scraped.** `cnpg_pg_database_size_bytes` returns empty. The metric series isn't being collected; that's a tesserix-k8s ServiceMonitor config to add later. Current dashboard shows "—" gracefully.
- **`TooltipProvider` is required at the React tree root** for `@tesserix/web` Tooltips to mount. The admin layout had `ToastProvider` but not `TooltipProvider` — caused the initial "Something went wrong" failure.
- **SendGrid free plan retired May 2025.** Current account either grandfathered legacy free or 60-day trial. Email Activity API retention is 3-7 days only — pivoting to ingesting Event Webhook into notification-service ourselves was the right call (also unlocks future E2 notification log).
- **Per-tenant CPU/memory is not honestly attributable.** Storage + activity is. The "Estimated cost share" pattern with "Estimated" in the heading + info-icon tooltip + attribution breakdown is the honest way to show derived numbers.

## Patterns to reuse

- **Federated read (FR)** via `tesserix_admin` Postgres role — confirmed pattern; reused in Phase 2 (subscriptions/dunning).
- **`ProductConfig`-driven layouts** — `<ProductOverviewLayout>` and `<TenantDetailLayout>` work for any product; adding HomeChef tomorrow is config-only.
- **Per-section graceful degradation** with `Promise.allSettled` in aggregators — one upstream failing doesn't take down the whole route.
- **60s in-memory TTL cache** in metric clients — prevents Prometheus query storms during multi-operator viewing.
- **Cost-honesty pattern** ("Estimated" in title + attribution inline + info-icon tooltip) — applies to any derived/proxy number; reused in Phase 2 Margin section.
- **Scoped error boundary at segment level** (`app/admin/error.tsx`) — keeps shell intact when a page throws.

## What we'd do differently

- **Add `TooltipProvider` to admin layout from day 1** — cost us one user-visible failure.
- **Surface "loading | empty | error" states upfront in spec** — UX-SPEC §4 captured this but the implementation initially conflated "API errored" with "this section's data is null" in the cost section. Fixed in polish.
- **Verify ServiceMonitor coverage early** — CNPG metrics being absent is a Phase 1 surprise that could've been caught with a Prometheus query test in Wave 0.

---

## Phase 2 inherits

- `lib/metrics/cost-proxy.ts` (Margin section)
- `lib/products/types.ts` and `configs.ts` (extended with `pricingByPlan`)
- `lib/db/mark8ly.ts` patterns (extended into `mark8ly-billing.ts`)
- All `components/admin/metrics/` primitives
- `<ProductOverviewLayout>` and `<TenantDetailLayout>` (extended with new sections)
- `app/admin/error.tsx` boundary

Phase 2 plan: `.planning/phases/02-subscriptions-billing/PLAN.md`.
