# Phase 1: Resources + Cost Dashboards — Plan

**Read first:** `CONTEXT.md` and `UX-SPEC.md` in this directory. `BACKLOG.md` at repo root.

**Goal:** Ship resource/cost/email visibility on Mark8ly Overview + tenant detail pages, with a generalizable `ProductConfig`-driven layout that future products inherit. Zero risk to live mark8ly send paths beyond a metadata-only `custom_args` instrumentation.

---

## Wave structure

Tasks within a wave are independent; waves are sequential. Mark `// PARALLELIZE` in execution context for dispatching.

```
Wave 0    →  Infra prerequisites (tesserix-k8s repo + DB grants + SendGrid webhook config)
Wave 1    →  Backend foundations (lib/metrics, types, ProductConfig)
Wave 1.5  →  notification-service: email_events table + SendGrid webhook receiver
Wave 2    →  Backend API routes (product + tenant metrics endpoints)
Wave 3    →  Frontend primitives (KPI tile, sparkline, breakdown stack, time picker)
Wave 4    →  Frontend pages (Overview rebuild + tenant detail rebuild)
Wave 5    →  Mark8ly send-site custom_args instrumentation (separate PR per service)
Wave 6    →  Visual polish + a11y audit
```

---

## Wave 0 — Infra prerequisites (tesserix-k8s repo, manual)

These are NOT tesserix-home changes. They're prerequisites in the sibling `tesserix-k8s` repo and runbook execution. Do these first; downstream work blocks on them.

### T0.1 — Set Prometheus URL env var in tesserix-home
- File: `tesserix-k8s/charts/apps/company/values.yaml` — add `PROMETHEUS_URL: "http://prometheus-server.monitoring"`
- **No ESO secret needed** — Prometheus is open within mesh (verified live 2026-05-01).
- Verify: redeploy company; `kubectl exec ... -- env | grep PROMETHEUS_URL` shows the value.
- Risk: None.

### T0.2 — Whitelist tesserix in OpenCost via Istio AuthorizationPolicy
- File: `tesserix-k8s/charts/apps/opencost-authpolicy/templates/authorization-policy.yaml` (new) OR add to existing `charts/thirdparty/opencost/templates/`
- Allow source: `cluster.local/ns/tesserix/sa/<tesserix-home-sa>` to call `opencost.opencost:9003`.
- File: `tesserix-k8s/charts/apps/company/values.yaml` — add `OPENCOST_URL: "http://opencost.opencost:9003"`
- Verify: from `company` pod, `wget http://opencost.opencost:9003/allocation/compute?window=24h&aggregate=namespace` returns `mark8ly` entry.
- Risk: Low. Read-only path. No production data exposure.

### T0.3 — Configure SendGrid Event Webhook (replaces old SendGrid Activity API task)
- SendGrid console → Mail Settings → Event Webhook:
  - Endpoint: `https://notification-service.<prod-domain>/webhooks/sendgrid` (final URL TBD; pick a path that fits notification-service's existing routing).
  - Events: select `processed`, `delivered`, `opened`, `bounce`, `dropped`, `unsubscribe`, `spamreport` at minimum.
  - Enable Signed Event Webhook → copy public key for HMAC verification.
- Add public key to GSM as `notification-service-sendgrid-webhook-secret`; ESO entry in `notification-service` namespace.
- **Do NOT enable** until T1.5.1 (webhook receiver) is deployed — SendGrid will retry failed webhooks but it's noisy.
- Risk: None until enabled. Once enabled: invalid signature events are rejected with HMAC verify.

### T0.4 — Cross-DB SELECT grants on mark8ly tables
- Per `tesserix-k8s/docs/cross-db-admin.md` runbook, grant `tesserix_admin` role on `mark8ly-postgres.marketplace` DB:
  ```sql
  GRANT SELECT ON marketplace.stores, marketplace.orders,
                  marketplace.products, marketplace.customer_profiles
  TO tesserix_admin;
  ```
- Q4 confirmed: actual table is `customer_profiles`, not `customers`.
- Verify: from `company` pod, `psql -c "SELECT count(*) FROM marketplace.orders"` succeeds.
- Risk: Low. Read-only. Pre-existing role.

**Wave 0 acceptance:** Prometheus + OpenCost reachable (verified by `wget` from `company` pod). Cross-DB row counts queryable. SendGrid webhook configured but disabled until receiver deployed.

---

## Wave 1 — Backend foundations

### T1.1 — Define `ProductConfig` type and per-product config registry
- New file: `lib/products/config.ts`
- Defines:
  ```ts
  interface ProductConfig {
    id: string;                    // "mark8ly"
    name: string;                  // "Mark8ly"
    namespace: string;             // K8s namespace
    cnpgClusterName: string;       // "mark8ly-postgres"
    sendGridProductTag: string;    // value of custom_args.product
    rowCountTables: ReadonlyArray<{ label: string; tableName: string }>;
    costAttribution: {
      requestsWeight: number;      // 0.5
      storageWeight: number;       // 0.3
      egressWeight: number;        // 0.2
    };
    businessKpiTiles: ReadonlyArray<KpiTileSpec>;
  }
  ```
- Initial registry: `mark8ly` only.
- Acceptance: `getProductConfig("mark8ly")` returns a typed object; unknown ID throws.

### T1.2 — Prometheus client wrapper
- New file: `lib/metrics/prometheus.ts`
- Reads `PROMETHEUS_URL` + `PROMETHEUS_TOKEN` from env.
- Single function: `query(promql: string, time?: Date): Promise<PromResult>` and `queryRange(promql, start, end, step): Promise<PromMatrix>`.
- 60s in-memory cache keyed on (query, time-bucket).
- Acceptance: Unit-tested against Prometheus query response shape; handles 5xx/timeout with typed error.

### T1.3 — OpenCost client wrapper
- New file: `lib/metrics/opencost.ts`
- Function: `getNamespaceCost(namespace: string, window: TimeWindow): Promise<NamespaceCost>` returning `{ total, cpu, ram, pv, network, lb }` in AUD.
- Note: OpenCost returns USD by default. Convert via static rate or surface the currency from response. Decision: surface currency in response, render in UI.
- Acceptance: Returns valid breakdown for `mark8ly` namespace.

### T1.4 — Notification-service email events client
- New file: `lib/metrics/email-events.ts`
- Function: `getEmailMetrics(filters: { product: string; tenantId?: string; days: number }): Promise<EmailMetrics>` returning `{ sent, delivered, opens, bounces, unsubscribes }`.
- Calls `notification-service` internal API (e.g., `GET /internal/email-events/aggregate?product=mark8ly&tenant_id=...&days=30`).
- Auth: existing service-to-service token pattern in tesserix namespace.
- Acceptance: Returns zero counts gracefully when no events recorded yet (e.g., before Wave 5 instrumentation lands). Fixture-based unit test.

### T1.5 — Cross-DB tenant metrics queries
- Extend `lib/db/mark8ly.ts` with:
  - `getTenantStorageBytes(tenantId): Promise<number>` — sum `pg_total_relation_size` per table where rows have `WHERE tenant_id = $1`
  - `getTenantRowCounts(tenantId, tables): Promise<Record<string, number>>`
- Acceptance: Returns counts for the-bondi-store; gracefully returns 0 if table empty for tenant.

### T1.6 — Cost-proxy calculator
- New file: `lib/metrics/cost-proxy.ts`
- Function: `computeTenantCostShare(tenant, product, opts): Promise<TenantCostShare>` returning `{ estimatedAud, breakdown: { requests, storage, egress } }`.
- Pulls: tenant's request count from Prom (by `tenant_id` label), tenant's storage from cross-DB, tenant's egress from Prom (Istio access metrics filtered by tenant subdomain).
- Combines via weighted formula from `ProductConfig.costAttribution`.
- Acceptance: Sum of all tenants' shares ≈ product's total cost (within 5% rounding).

### Wave 1 acceptance
- `lib/metrics/` directory complete with typed clients
- Each client unit-tested against fixture responses (no live network in tests)
- ProductConfig registry resolves mark8ly correctly

---

## Wave 1.5 — notification-service email events ingestion

**Repo:** `notification-service` (separate repo from tesserix-home). Small, additive, no breaking changes. Phase 1 scope includes this work.

### T1.5.1 — `email_events` table migration
- New migration: `email_events` table with columns:
  ```
  id              uuid primary key
  sg_event_id     text unique  -- SendGrid's sg_event_id, dedupe key
  email           text
  event_type      text         -- processed | delivered | open | bounce | dropped | unsubscribe | spamreport
  tenant_id       text         -- from custom_args
  product         text         -- from custom_args (e.g., "mark8ly")
  template_key    text         -- from custom_args (optional)
  reason          text         -- bounce/drop reason (nullable)
  occurred_at     timestamptz  -- SendGrid timestamp
  received_at     timestamptz  -- our ingestion time
  raw_payload     jsonb        -- full event for debugging
  ```
- Indexes: `(product, tenant_id, occurred_at DESC)`, `(product, occurred_at DESC)`, `(sg_event_id)` unique.
- Retention: forever for now; revisit at Phase 4+.

### T1.5.2 — `POST /webhooks/sendgrid` receiver
- HMAC verification using `notification-service-sendgrid-webhook-secret` from ESO. Reject 401 on signature failure.
- Parse SendGrid batch JSON; insert rows with `INSERT ... ON CONFLICT (sg_event_id) DO NOTHING` for idempotency.
- Return 200 within 1s — SendGrid times out and retries otherwise.
- Log rejections + ingestion counts to existing logging infra.

### T1.5.3 — `GET /internal/email-events/aggregate` query endpoint
- Internal-only route (admin auth or service-to-service token).
- Query params: `product`, `tenant_id?`, `days` (default 30).
- Returns: `{ sent, delivered, opens, bounces, unsubscribes, dropped }` aggregated counts.
- Underlying SQL: 5 grouped count queries on indexed columns.

### T1.5.4 — Enable SendGrid webhook
- After T1.5.1–T1.5.3 deployed, enable Event Webhook in SendGrid console (T0.3 prepared but disabled).
- Verify: trigger a test send from mark8ly platform-api; confirm row appears in `email_events` within seconds.

### Wave 1.5 acceptance
- Webhook accepts valid SendGrid events, rejects forged ones (HMAC verify proven via test fixture).
- `/internal/email-events/aggregate` returns correct counts for mark8ly product (will be 0 until Wave 5 lands `custom_args` instrumentation).
- Migration deployed; rollback plan documented (drop table; webhook can stay configured but receiving 404 won't break SendGrid sends).

---

## Wave 2 — API routes

### T2.1 — `GET /api/admin/apps/[product]/metrics`
- File: `app/api/admin/apps/[product]/metrics/route.ts`
- Query params: `window=1h|24h|7d|30d` (default 24h)
- Auth: existing admin session check (reuse pattern from `app/api/admin/dashboard/route.ts`)
- Response shape:
  ```ts
  {
    ok: true,
    data: {
      product: { id, name },
      window: "24h",
      generatedAt: ISO,
      resources: {
        cpu: { current: number, sparkline: number[] },
        memory: { current: number, sparkline: number[] },
        pods: { count: number },
        db: { sizeBytes, replicationLag, connections }
      },
      cost: {
        currency: "AUD",
        total: number,
        breakdown: { cpu, ram, pv, network, lb },
        sparkline: number[]
      },
      email: {  // always 30d window
        sent, delivered, opens, bounces, unsubscribes
      }
    }
  }
  ```
- 60s cache via `lib/metrics/prometheus.ts` cache.

### T2.2 — `GET /api/admin/apps/[product]/tenants/[id]/metrics`
- File: `app/api/admin/apps/[product]/tenants/[id]/metrics/route.ts`
- Same auth/window/cache pattern.
- Response shape:
  ```ts
  {
    ok: true,
    data: {
      tenant: { id, name, subdomain },
      window: "24h",
      activity: {
        storageBytes: number,
        rowCounts: Record<string, number>,  // from rowCountTables
        requestRate: { current: number, sparkline: number[] },
        bandwidth: { inSparkline: number[], outSparkline: number[] }
      },
      email: { sent, delivered, opens, bounces, unsubscribes },  // 30d
      costShare: {
        currency: "AUD",
        estimated: number,
        breakdown: { requestsWeight, storageWeight, egressWeight,
                     requestsValue, storageValue, egressValue }
      }
    }
  }
  ```

### T2.3 — Error handling envelope
- All routes use existing error envelope pattern: `{ ok: false, error: "code", message?: string }`.
- Specific codes: `prometheus_unavailable`, `opencost_unavailable`, `sendgrid_unavailable`, `db_unavailable`. UI handles each granularly (one section degraded, rest still load).

### Wave 2 acceptance
- Both routes return valid JSON with realistic mark8ly data when called from authenticated browser
- Each upstream failure (Prom down / OC down / SG down / DB down) returns partial data — never 500s the whole route

---

## Wave 3 — Frontend primitives

Per `UX-SPEC.md` §3.

### T3.1 — `<KpiTile>` component
- File: `components/admin/metrics/kpi-tile.tsx`
- Props: `{ label, value, hint?, deltaPill?, icon?, href?, dataSource?, lastRefreshedAt? }`
- Composes `@tesserix/web` Card. Tooltip showing data source + last refreshed.
- Optional `<Link>` wrapper if `href` provided.
- Empty state: en-dash. Loading state: Skeleton. ARIA: `aria-label` on value.

### T3.2 — `<SparklineCard>` component
- File: `components/admin/metrics/sparkline-card.tsx`
- Props: `{ label, currentValue, series: number[], color?, baseline?: 0 }`
- recharts `AreaChart`, axes hidden (or zero-baseline if `baseline=0`), `fillOpacity={0.15}`.
- Wraps in `<figure>` with `<figcaption>` describing trend (current + peak + time).
- Container `aria-hidden="true"`.

### T3.3 — `<CostBreakdownStack>` component
- File: `components/admin/metrics/cost-breakdown.tsx`
- Props: `{ total, currency, breakdown: Record<string, number> }`
- Single horizontal stacked bar (recharts) with hover tooltips.
- Below the bar: `<dl>` of category → AUD amount + percent.

### T3.4 — `<TimeWindowPicker>` component
- File: `components/admin/metrics/time-window-picker.tsx`
- `@tesserix/web` Select. Options: 1h, 24h, 7d, 30d. Default 24h.
- `onChange(window: TimeWindow)` callback.

### T3.5 — `<RefreshControl>` component
- File: `components/admin/metrics/refresh-control.tsx`
- Ghost icon button with `RefreshCw`, `motion-safe:animate-spin` while loading.
- `onClick` callback. Triggers Sonner toast on success.

### T3.6 — `<MetricsSection>` wrapper
- File: `components/admin/metrics/section.tsx`
- Props: `{ id, title, description?, lastRefreshedAt?, error?, children }`
- Renders `<section aria-labelledby={id}>`, hairline rule beneath title, stale-timestamp logic per UX-SPEC §4 (amber if >15min old).
- Inline error block (matching existing tenants page error treatment) when `error` passed.

### Wave 3 acceptance
- All primitives Storybook-style demonstrable in isolation
- Each respects loading / empty / error states per spec
- Type-check passes
- a11y: keyboard nav works, focus rings visible, screen reader reads sensible text

---

## Wave 4 — Frontend pages

### T4.1 — Build `<ProductOverviewLayout>` generic component
- File: `components/admin/product-overview-layout.tsx`
- Props: `{ config: ProductConfig }`
- Fetches `/api/admin/apps/{config.id}/metrics` via `useSWR`
- Renders sections per UX-SPEC §1: page header (title + time picker + refresh), business KPIs, resources, cost, email.
- Each section uses primitives from Wave 3.
- No "mark8ly" string anywhere — fully config-driven.

### T4.2 — Refactor `app/admin/apps/mark8ly/page.tsx` to use the layout
- Replace existing implementation with `<ProductOverviewLayout config={mark8lyConfig} />`.
- Convert from server component (current) to client component since metrics are interactive (time picker, refresh) — or split into RSC shell + client metrics island. Decision: client component for the whole page; SSR not needed for a non-public admin tool. Keep current server-side `headers()` pattern for the dashboard fetch only if clean; otherwise drop.
- Acceptance: page renders all 4 sections with mark8ly data.

### T4.3 — Build `<TenantDetailLayout>` generic component
- File: `components/admin/tenant-detail-layout.tsx`
- Props: `{ config: ProductConfig; tenantId: string }`
- Fetches `/api/admin/apps/{config.id}/tenants/{tenantId}/metrics` via `useSWR`
- Renders sections per UX-SPEC §2: identity (existing detail content stays), activity, email, cost proxy with attribution.

### T4.4 — Refactor `app/admin/apps/mark8ly/tenants/[id]/page.tsx`
- Compose existing identity content + new `<TenantDetailLayout>` activity/email/cost sections.

### Wave 4 acceptance
- Browser shows complete Mark8ly Overview with all sections live
- Browser shows complete tenant detail for at least one mark8ly tenant
- Time window picker triggers refetch; refresh button works with toast
- Loading / empty / stale / error states visible by simulating each

---

## Wave 5 — Mark8ly send-site `custom_args` instrumentation

**Risk: this touches live mark8ly services. One PR per service. Test in dev. Roll forward, not back.**

### T5.1 — `mark8ly/services/platform-api`
- Audit send sites: welcome, password_reset, invitation, email_verification (in `internal/notification/`).
- Add `customArgs: map[string]string{ "tenant_id": tenantID, "product": "mark8ly" }` to each SendGrid request.
- Verify: send a test email, confirm SendGrid Activity API shows the custom_args.

### T5.2 — `mark8ly/services/marketplace-api`
- Audit send sites: campaign, dunning, gift card delivery, invoice/receipt/refund/cancellation (in `internal/{campaign,giftcard,orderdoc,subscription}`).
- Same instrumentation.

### T5.3 — `mark8ly/services/otto`
- Audit send sites: OTP send (in `internal/`).
- Same instrumentation.

### Wave 5 acceptance
- After all three PRs deployed, SendGrid Activity API filtered by `custom_args.tenant_id=<id>` returns events for new sends
- No regression in mark8ly email delivery (smoke test: trigger welcome email for a test tenant)

---

## Wave 6 — Visual polish + a11y audit

### T6.1 — Apply impeccable design skills
Run, in this order, against the new pages:
1. `arrange` — verify layout rhythm, spacing, hierarchy
2. `typeset` — verify type scale, weight, readability
3. `clarify` — verify copy on labels, tooltips, info text
4. `harden` — empty/error states, edge cases, reduced motion
5. `polish` — final pass: alignment, consistency, micro-detail

### T6.2 — Lighthouse a11y run
- Both pages must score ≥ 95 on Lighthouse Accessibility audit
- Fix any violations before phase complete

### T6.3 — Manual keyboard-only walkthrough
- Tab from page top through all interactive elements
- Verify focus rings visible
- Verify Tooltip triggers work via Enter/Space
- Verify time picker / refresh / drill-down links all reachable

### Wave 6 acceptance
- All design skills applied, no flagged issues
- Lighthouse a11y ≥ 95
- Manual keyboard test passes
- No console errors / warnings on either page

---

## Risk-driven sequencing notes

- **Wave 5 (mark8ly instrumentation) starts only after Wave 1.5 deployed.** Otherwise `custom_args` tags fly into a void. Sequence: 0 → (1, 1.5 in parallel) → 2 → (3, 4) → 5 → 6.
- **Wave 0 has manual steps** (Istio AuthZ Policy PR, DB grants, SendGrid webhook setup) — kick off first thing Phase 1, parallel with Wave 1 backend foundations.
- **Wave 1.5 = notification-service repo** — separate PR, separate review, but Phase-1 owned. Has its own deployment cycle.
- **SendGrid webhook stays disabled until T1.5.4.** Premature enablement floods notification-service with 404s and SendGrid retries.
- **Wave 6 design polish gates phase completion.** Don't ship without it.

---

## Definition of done (phase)

- [ ] All Wave 0–6 tasks complete and acceptance criteria met
- [ ] CONTEXT.md acceptance criteria all checked
- [ ] CI green on tesserix-home
- [ ] Deployed to prod (rollout complete on `company` deployment)
- [ ] One operator (you) can use both pages for daily ops without confusion
- [ ] No mark8ly email regressions (verified via send-test on welcome + invoice templates)
- [ ] PHASE-1-SUMMARY.md written: what shipped, surprises, deferred items, learnings
