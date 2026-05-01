# Phase 1: Resources + Cost Dashboards — Context

**Status:** Ready for planning
**Source:** Backlog conversation 2026-05-01
**Surfaces:** `/admin/apps/mark8ly` (Overview) + `/admin/apps/mark8ly/tenants/[id]` (Tenant detail)
**Backlog refs:** K1, K2, K4, L1, L2

---

## Phase boundary

Add resource, activity, and cost visibility to the super-admin tool. Read-only across all data sources. Zero changes to mark8ly send paths or product service runtime behavior. Pattern must generalize to future products.

**In scope:**
- K1: Per-product resources (CPU, memory, pods, DB cluster health) on Mark8ly Overview
- K2: Per-tenant activity (storage, row counts, request rate, bandwidth) on tenant detail
- K4: Email volume metrics (sent/delivered/opens/bounces) per product + per tenant — sourced from `notification-service.email_events` populated by SendGrid Event Webhook (NOT Activity API)
- L1: Per-product cost (CPU/RAM/PV/network/LB) on Mark8ly Overview from OpenCost
- L2: Per-tenant cost proxy = product cost × tenant activity share (50/30/20 weighted: requests/storage/egress)
- **Notification-service additions** (small, additive — no breaking changes): new `email_events` table + `POST /webhooks/sendgrid` endpoint with HMAC signature verification, owned by Phase 1.

**Out of scope:**
- L3 GCP Billing Export → BigQuery (deferred to Phase 4)
- CPU/memory at tenant level (not honestly attributable)
- Templates registry, lead invites, tickets, audit logs (later phases)
- Auto-refresh polling (manual refresh only in Phase 1)
- Cross-AI peer review of plan

---

## Locked decisions

### Architecture
- New shared lib at `lib/metrics/` wrapping: Prometheus client, OpenCost client, SendGrid Activity API, cross-DB read helpers.
- New API routes:
  - `GET /api/admin/apps/[product]/metrics?window=24h` — product-level resource + cost + email
  - `GET /api/admin/apps/[product]/tenants/[id]/metrics?window=24h` — tenant-level activity + cost share
- Browser never calls Prometheus / OpenCost / SendGrid directly. All proxied through tesserix-home API routes with admin session check (existing `getAdminSession` pattern).
- 60-second in-memory cache per route to avoid Prometheus query storms during multi-operator viewing.
- All API routes return JSON envelope: `{ ok: true, data: {...} } | { ok: false, error: "code" }`.

### Data sources
- **Prometheus:** in-cluster service `prometheus-server.monitoring`. **Verified reachable from `tesserix` pods with no auth required** (probed live 2026-05-01). Env var only: `PROMETHEUS_URL`. No ESO token.
- **OpenCost:** in-cluster service `opencost.opencost:9003`. **Currently blocked from `tesserix` namespace** — needs an Istio AuthorizationPolicy in `opencost` namespace allowing `tesserix` SA. Once allowed, no auth token needed at API level.
- **Email events:** `notification-service.email_events` table, populated by SendGrid Event Webhook hitting `notification-service:/webhooks/sendgrid`. Each event carries `tenant_id` + `product` from `custom_args` set by mark8ly send sites (Wave 5). NOT SendGrid Activity API — free/Essentials plan only retains 3-7 days, insufficient for 30-day windows.
- **Cross-DB read:** existing `tesserix_admin` Postgres role + `mark8ly-platform-admin` secret already in `tesserix` namespace. SELECT grants needed on: `stores`, `orders`, `products`, `customer_profiles` in `marketplace-api` DB (per `tesserix-k8s/docs/cross-db-admin.md`).

### Mark8ly send-site instrumentation
- Add `custom_args: { tenant_id, product: "mark8ly" }` to every existing SendGrid send call across mark8ly services (platform-api, marketplace-api, otto). **Metadata-only change**, zero behavior risk. Required so SendGrid Activity API can filter per tenant.
- This is the only mark8ly code change in Phase 1.

### Cost attribution
- Per-tenant cost = product cost × tenant share.
- Composite share weights (mark8ly): **50% request count + 30% DB storage + 20% egress bytes**.
- Weights live in a per-product `ProductConfig` constant — future products can override.
- UI explicitly labels this as "Estimated" with attribution basis visible inline.

### UI
- Design spec: `UX-SPEC.md` (this directory) — read before implementing.
- Component primitives: `@tesserix/web` (shadcn/Radix).
- Charts: `recharts`.
- Design direction: modern clean admin (Linear/Vercel-style), NOT Mark8ly editorial brand.
- Pages must take a `ProductConfig` prop so HomeChef/FanZone can reuse layouts without changes.

### Time windows
- Resource & cost: configurable per-page (1h / 24h / 7d / 30d). Default 24h.
- Email: fixed 30d (SendGrid API granularity).

### Auth & secrets
- **No new secrets in `tesserix-home`** for Prometheus or OpenCost (in-cluster, no auth). Just env vars `PROMETHEUS_URL` and `OPENCOST_URL`.
- **New ESO secret in `notification-service`** namespace: `notification-service-sendgrid-webhook-secret` — SendGrid event webhook HMAC verification key (set in SendGrid console → Mail Settings → Event Webhook → Signature). Used by webhook receiver to validate incoming events.
- **Postgres `tesserix_admin` SELECT grants** on `mark8ly-postgres.marketplace.{stores, orders, products, customer_profiles}` — applied via `tesserix-k8s/docs/cross-db-admin.md` runbook (manual phase).
- **Existing secret reused:** `mark8ly-platform-admin` (basic-auth) in `tesserix` namespace — already provisioned for cross-DB reads.

---

## Canonical references

### In this phase directory
- `UX-SPEC.md` — page layouts, component patterns, accessibility, generalization

### In repo root
- `BACKLOG.md` — feature backlog with phase plan
- `components/admin/sidebar.tsx` — sidebar shell
- `app/admin/apps/mark8ly/page.tsx` — current Overview (3 SectionCards)
- `app/admin/apps/mark8ly/tenants/[id]/page.tsx` — current tenant detail
- `lib/db/mark8ly.ts` — existing cross-DB read patterns

### In sibling repos
- `tesserix-k8s/docs/cross-db-admin.md` — Postgres role grant runbook
- `tesserix-k8s/charts/thirdparty/opencost/` — OpenCost deployment
- `tesserix-k8s/k8s/cluster/prometheus/` — Prometheus deployment
- `tesserix-k8s/charts/apps/mark8ly-postgres/templates/prometheusrule.yaml` — CNPG metric names already in use
- `mark8ly/services/platform-api/internal/notification/`, `mark8ly/services/marketplace-api/internal/{campaign,giftcard,orderdoc}/`, `mark8ly/services/otto/internal/` — SendGrid send sites needing `custom_args` instrumentation

---

## Resolved decisions (Q1–Q4)

All four are locked as of 2026-05-01:

| # | Decision | How verified |
|---|---|---|
| Q1 | Prometheus accessed via cluster-local service `prometheus-server.monitoring`, no auth | Live `wget` from `company` pod returned valid response |
| Q2 | OpenCost `opencost.opencost:9003` reached via Istio AuthorizationPolicy whitelisting `tesserix` SA — added in tesserix-k8s repo as Wave 0 task | Live probe confirmed currently blocked; user confirmed whitelist is the chosen approach |
| Q3 | SendGrid Activity API NOT used. Instead: SendGrid Event Webhook → `notification-service.email_events`. Drives K4 + future E2 (notification log). | Confirmed free/Essentials plan retains only 3-7 days of activity data, insufficient for 30-day windows |
| Q4 | Tenant row-count tables: `stores`, `orders`, `products`, `customer_profiles`. Note: actual table is `customer_profiles`, not `customers`. | Verified via grep of mark8ly migration SQL |

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Prometheus query storm under multi-operator viewing | Med | 60s per-route cache + page-level loading skeleton (no aggressive auto-refresh) |
| SendGrid Activity API rate limits | Low | Cache 5min; SendGrid limit is generous for our query rate |
| Cross-DB connection saturation | Low | Reuse existing `lib/db/mark8ly.ts` connection pool; no new long-running queries |
| Sparkline render perf on large series | Low | recharts handles 24h × 1min = 1440 points fine; downsample server-side if needed |
| Mark8ly `custom_args` instrumentation breaks email sends | **Critical (mark8ly is live)** | Metadata-only addition; SendGrid ignores unknown custom_args; deploy each service independently with rollback ready |
| Misleading cost-proxy interpretation | Med | UX spec § 5 "Cost honesty" — "Estimated" in heading + attribution inline + info tooltip |
| SendGrid webhook signature verification missing or wrong | **Critical (forged events corrupt metrics)** | HMAC verification on every webhook request; reject unsigned/invalid; log rejections; secret stored in ESO |
| Webhook flooding / DoS on notification-service | Low | Existing notification-service rate limits + Istio ingress; webhook events are bounded by SendGrid send volume |

---

## Acceptance criteria (phase-level)

- [ ] Mark8ly Overview shows: business KPIs (existing) + Resources + Cost + Email sections
- [ ] Tenant detail shows: identity (existing) + Activity + Email + Cost-proxy sections
- [ ] Time window picker controls Resources & Cost; Email fixed 30d
- [ ] Refresh control with toast + ARIA label
- [ ] All metrics load via tesserix-home API routes (browser never sees Prom/OpenCost/SendGrid directly)
- [ ] Per-tenant cost displays attribution basis breakdown + info tooltip
- [ ] Pages take a `ProductConfig` so HomeChef/FanZone reuse without layout changes
- [ ] Loading / empty / stale / error states styled per UX spec § 4
- [ ] WCAG 2.1 AA: keyboard nav, focus rings, sparkline figcaptions, info-icon as `<button>`, `prefers-reduced-motion` honored
- [ ] mark8ly send sites instrumented with `custom_args: { tenant_id, product }` — verified by SendGrid Activity API showing per-tenant filtered results within 24h of deploy
- [ ] Type check passes (`tsc --noEmit`)
- [ ] No new browser console errors
- [ ] Lighthouse a11y ≥ 95 on both pages
