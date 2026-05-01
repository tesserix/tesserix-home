# Phase 1: Resources + Cost Dashboards — Plan

**Read first:** `CONTEXT.md` and `UX-SPEC.md` in this directory. `BACKLOG.md` at repo root.

**Goal:** Ship resource/cost/email visibility on Mark8ly Overview + tenant detail pages, with a generalizable `ProductConfig`-driven layout that future products inherit. Zero risk to live mark8ly send paths beyond a metadata-only `custom_args` instrumentation.

---

## Wave structure

Tasks within a wave are independent; waves are sequential. Mark `// PARALLELIZE` in execution context for dispatching.

```
Wave 0  →  Infra prerequisites (tesserix-k8s repo + DB grants)
Wave 1  →  Backend foundations (lib/metrics, types, ProductConfig)
Wave 2  →  Backend API routes (product + tenant metrics endpoints)
Wave 3  →  Frontend primitives (KPI tile, sparkline, breakdown stack, time picker)
Wave 4  →  Frontend pages (Overview rebuild + tenant detail rebuild)
Wave 5  →  Mark8ly send-site custom_args instrumentation (separate PR per service)
Wave 6  →  Visual polish + a11y audit
```

---

## Wave 0 — Infra prerequisites (tesserix-k8s repo, manual)

These are NOT tesserix-home changes. They're prerequisites in the sibling `tesserix-k8s` repo and runbook execution. Do these first; downstream work blocks on them.

### T0.1 — Provision Prometheus read-only access for tesserix-home
- File: `tesserix-k8s/charts/apps/company/templates/` (add ServiceAccount + RBAC for read-only Prom)
- File: `tesserix-k8s/external-secrets/prod/tesserix/externalsecret.yaml` — add `tesserix-home-prometheus-token` entry sourced from GSM
- Verify: `kubectl exec` into tesserix-home pod and `curl prometheus:9090/api/v1/query?query=up` returns 200
- Risk: Low. Read-only access. No mark8ly impact.

### T0.2 — Provision OpenCost access (if needed)
- Check whether the in-cluster `opencost` service requires auth from `tesserix` namespace (mesh policy).
- If yes: add ESO entry + service account; if no: skip.
- Verify: `curl opencost.opencost:9003/allocation/compute?window=24h&aggregate=namespace` from tesserix-home pod returns mark8ly entry.

### T0.3 — Provision SendGrid Activity API key
- Confirm SendGrid plan tier includes Activity API (CONTEXT.md Q3). If not, parking K4 partial — UI shows "—" for email metrics.
- Create scoped API key with `Email Activity Read` only — NOT full key.
- Add to GSM, ESO entry → K8s secret `tesserix-home-sendgrid-readonly-key`.

### T0.4 — Cross-DB SELECT grants on mark8ly tables
- Per `tesserix-k8s/docs/cross-db-admin.md` runbook, grant `tesserix_admin` role:
  ```sql
  GRANT SELECT ON mark8ly.tenants, mark8ly.stores, mark8ly.orders,
                mark8ly.products, mark8ly.customers TO tesserix_admin;
  ```
  (Confirm exact table list with mark8ly DB owner — answers CONTEXT.md Q4.)
- Verify: from tesserix-home pod, `psql -c "SELECT count(*) FROM orders"` succeeds.

**Wave 0 acceptance:** All three external dependencies (Prom, OpenCost, SendGrid) reachable from tesserix-home pod with read-only credentials. Cross-DB row counts queryable.

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

### T1.4 — SendGrid Activity API wrapper
- New file: `lib/metrics/sendgrid.ts`
- Function: `getEmailMetrics(filters: { product: string; tenantId?: string; days: number }): Promise<EmailMetrics>` returning `{ sent, delivered, opens, bounces, unsubscribes }`.
- Uses `GET /v3/messages?query=...` with custom_args filter.
- Acceptance: Returns zero counts gracefully when no events match (e.g., before mark8ly is instrumented in Wave 5).

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

- **Wave 5 is dependent on Wave 0+2 only.** It can start in parallel with Wave 3+4 if a separate engineer is doing the mark8ly side. We'll defer kicking off Wave 5 until Wave 4 demo proves the Activity API is working — that way, we know the instrumentation will actually be visible in the dashboard.
- **Wave 0 has manual steps** (DB grants, GSM secrets) — kick off first thing Phase 1, parallel with Wave 1 backend foundations.
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
