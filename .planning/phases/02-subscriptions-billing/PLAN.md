# Phase 2: Subscriptions, Dunning + Trial Management — Plan

**Read first:** `CONTEXT.md` and `UX-SPEC.md` in this directory. Phase 1 artifacts under `.planning/phases/01-resources-cost-dashboards/`.

**Goal:** Surface subscription health, revenue, and margin per tenant. Read-only across mark8ly. Reuse Phase 1 primitives. Generalize via `ProductConfig`.

---

## Wave structure

```
Wave 0  →  Infra prerequisites (DB grants, sidebar nav)
Wave 1  →  Backend foundations (lib/db/mark8ly-billing, ProductConfig pricing extension)
Wave 2  →  Backend API routes (subscriptions list, tenant billing, revenue aggregate)
Wave 3  →  Frontend primitives (PlanBadge, StatusBadge, PlanChangeTimeline, MarginCard)
Wave 4  →  Frontend pages (Subscriptions list page, tenant detail additions, Overview revenue section)
Wave 5  →  Visual polish + a11y audit
```

---

## Wave 0 — Infra prerequisites

### T0.1 — Cross-DB SELECT grants on mark8ly billing tables
- Per `tesserix-k8s/docs/cross-db-admin.md` runbook on `mark8ly-postgres.marketplace`:
  ```sql
  GRANT SELECT ON marketplace.store_subscriptions,
                  marketplace.stripe_webhook_events,
                  marketplace.subscription_plan_change_audit,
                  marketplace.billing_archive
  TO tesserix_admin;
  ```
- Verify: from `company` pod, `psql -c "SELECT count(*) FROM marketplace.store_subscriptions"` succeeds.
- Risk: Low. Read-only. Same role as Phase 1.

### T0.2 — Add Subscriptions nav entry to Mark8ly rail
- File: `components/admin/sidebar.tsx`
- Insert into `mark8lyNav` between Tenants and Leads (or after both — TBD by UX spec):
  ```ts
  { name: "Subscriptions", href: "/admin/apps/mark8ly/subscriptions", icon: CreditCard }
  ```
- Acceptance: Mark8ly rail shows the new entry; clicking routes to `/admin/apps/mark8ly/subscriptions`.

**Wave 0 acceptance:** SELECT grants executed; sidebar entry visible in admin UI.

---

## Wave 1 — Backend foundations

### T1.1 — Extend `ProductConfig` with billing fields
- File: `lib/products/types.ts` add:
  ```ts
  interface PricingPlan {
    readonly plan: string;
    readonly priceMonthly: number;
  }
  interface ProductConfig {
    // existing fields...
    readonly pricingByPlan?: Readonly<Record<string, number>>;  // optional — products without subscriptions skip
    readonly pricingCurrency?: string;                          // "USD"
  }
  ```
- File: `lib/products/configs.ts` — add to `mark8ly`:
  ```ts
  pricingByPlan: { trial: 0, starter: 29, studio: 79, pro: 149, marketplace: 299 },
  pricingCurrency: "USD",
  ```
  **Note:** Prices are PLACEHOLDERS. Confirm with mark8ly product owner before merging.
- Acceptance: Type-checks; `getProductConfig("mark8ly").pricingByPlan` returns the map.

### T1.2 — `lib/db/mark8ly-billing.ts` query helpers
- New file with the following functions:
  - `getSubscription(tenantId): Promise<Subscription | null>` — fetch one row from `store_subscriptions` by tenant
  - `listSubscriptions(filter?): Promise<Subscription[]>` — list all with optional `{plan?, status?, dunningOnly?, trialOnly?}` filter
  - `getPlanChangeHistory(tenantId, limit=10): Promise<PlanChange[]>` — from `subscription_plan_change_audit`
  - `getRecentInvoiceEvents(tenantId, limit=20): Promise<InvoiceEvent[]>` — from `stripe_webhook_events` filtered to `event_type LIKE 'invoice.%'`
  - `getLifetimeRevenue(tenantId): Promise<number>` — sum from `stripe_webhook_events` where `event_type = 'invoice.payment_succeeded'` (active) OR `billing_archive.total_revenue_usd` (archived)
- All functions parameterized; no string interpolation of user input.
- Acceptance: Unit-tested against fixture rows; gracefully returns null/empty on missing tenant.

### T1.3 — `lib/metrics/revenue.ts` aggregator
- New file with:
  - `computeMrr(productConfig, subs): number` — sum of `pricingByPlan[plan]` for `status='active'` subscriptions
  - `computeArr(mrr): number` — `mrr * 12`
  - `computeChurnRate(productConfig, days=30): Promise<{ rate, cancelledCount, baselineCount }>` — count `status='canceled'` rows where `updated_at` in window divided by `status IN ('active','past_due','trialing')` count at start of window
  - `computeNewTrials(days=30): Promise<number>` — count rows where `created_at` in window AND (`plan='trial'` OR `status='trialing'`)
  - `computeMrrSparkline(days=30): Promise<SparklinePoint[]>` — daily MRR snapshot over window; for Phase 2 use a simple "current MRR repeated" (no historical data); add a TODO to derive from plan-change-audit + invoice events when polish budget allows.
- Acceptance: Pure functions over fixture data; sparkline returns 30 points.

### T1.4 — `lib/metrics/margin.ts`
- New file:
  - `computeTenantMargin(productConfig, tenantId, window): Promise<{ revenue, infraCost, margin, currency }>`
  - Calls `getSubscription(tenantId)` for plan → revenue; calls Phase 1 `computeTenantCostShare` for infra cost; subtracts.
  - For trial tenants: `revenue=0`; mark `inTrial=true` so UI can suppress the margin or label it differently.
- Acceptance: Returns realistic numbers for a known active tenant; gracefully handles missing subscription (null margin).

### T1.5 — Trial conversion likelihood heuristic
- New file `lib/metrics/trial-likelihood.ts`:
  - `scoreTrialLikelihood(tenant, subscription, activitySignals): "low" | "medium" | "high"`
  - Inputs: trial age (days since `created_at`), order count, last-seen recency
  - Output bucket per CONTEXT.md heuristic
- Acceptance: Unit-tested with three boundary cases.

### Wave 1 acceptance
- All `lib/db/mark8ly-billing.ts` and `lib/metrics/{revenue,margin,trial-likelihood}.ts` files complete with typed exports.
- ProductConfig pricing extension type-checks.
- Each function unit-tested against fixtures.

---

## Wave 2 — API routes

### T2.1 — `GET /api/admin/apps/[product]/subscriptions`
- File: `app/api/admin/apps/[product]/subscriptions/route.ts`
- Query params: `sort` (default `current_period_end:asc`), `filter` (`active|trial|past_due|cancelled`), `limit` (default 200)
- Auth via existing middleware
- Response shape:
  ```ts
  {
    summary: { totalMrr, currency, trialCount, pastDueCount, cancelledThisMonth },
    rows: Array<{
      tenantId, tenantName, plan, status,
      currentPeriodEnd, mrr, lifetimeRevenue,
      dunningState?: "retrying" | "exhausted" | null,
      trialEndsInDays?: number,
      conversionLikelihood?: "low"|"medium"|"high"
    }>,
    generatedAt
  }
  ```
- Joins `store_subscriptions` with `tenants` (via cross-DB) for tenant names.
- 60s in-memory cache.
- Acceptance: Returns valid JSON with realistic mark8ly data; filter params correctly narrow rows.

### T2.2 — `GET /api/admin/apps/[product]/tenants/[id]/billing`
- File: `app/api/admin/apps/[product]/tenants/[id]/billing/route.ts`
- Returns subscription detail + plan-change history + lifetime revenue + recent invoice events for one tenant.
- Response shape:
  ```ts
  {
    subscription: { plan, status, currentPeriod, cancelAtPeriodEnd, ... } | null,
    dunning: { state, lastEventAt, retryCount, lastError } | null,
    trial: { daysRemaining, conversionLikelihood } | null,
    planHistory: PlanChange[],
    recentInvoices: InvoiceEvent[],
    lifetimeRevenue: { amount, currency } | null,
    margin: { revenue, infraCost, margin, currency } | null
  }
  ```

### T2.3 — `GET /api/admin/apps/[product]/revenue`
- File: `app/api/admin/apps/[product]/revenue/route.ts`
- Query params: `window` (`30d` default; `90d`, `1y`)
- Returns aggregate: `{ mrr, arr, churnRate, newTrials, sparkline, currency, generatedAt }`
- 60s cache.

### T2.4 — Error envelope
- All routes use existing `{ error: "code" }` pattern from Phase 1.
- Error codes: `db_unavailable`, `cost_proxy_unavailable`, `invalid_filter`.

### Wave 2 acceptance
- All three routes return valid JSON with realistic mark8ly data
- Each handles empty/no-data cases without 500s
- Filter, sort, and window params validate

---

## Wave 3 — Frontend primitives

Per `UX-SPEC.md`. Reuse Phase 1 primitives (KpiTile, MetricsSection) where possible.

### T3.1 — `<PlanBadge>` component
- File: `components/admin/billing/plan-badge.tsx`
- Props: `{ plan: string }` — renders monochrome weight-based hierarchy per UX spec; trial gets outlined/muted style.

### T3.2 — `<StatusBadge>` component
- File: `components/admin/billing/status-badge.tsx`
- Props: `{ status: string }` — color taxonomy: active=green, trialing=blue, past_due=amber, unpaid=red, canceled=neutral, etc.
- Uses `@tesserix/web` Badge.

### T3.3 — `<DunningPill>` component
- File: `components/admin/billing/dunning-pill.tsx`
- Props: `{ state: "retrying"|"exhausted"|null, retryCount?, lastEventAt? }`
- Shared icon (`AlertTriangle`); amber for retrying, red for exhausted; tooltip on hover with details.

### T3.4 — `<PlanChangeTimeline>` component
- File: `components/admin/billing/plan-change-timeline.tsx`
- Props: `{ changes: PlanChange[], collapsedAfter?: number }`
- Vertical timeline showing from→to plan, action, date, currency.
- Collapses to 3 items by default with "View all N changes" expansion.

### T3.5 — `<MarginCard>` component
- File: `components/admin/billing/margin-card.tsx`
- Props: `{ revenue, infraCost, margin, currency, inTrial?: boolean }`
- Negative margin → red primary value
- Trial tenant → gray "Trial — margin n/a yet" label
- Reuses Phase 1 cost-honesty pattern (info icon, "Estimated" in title)

### T3.6 — `<SubscriptionsTable>` component
- File: `components/admin/billing/subscriptions-table.tsx`
- Props: `{ rows, currentSort, onSortChange, currentFilter, onFilterChange }`
- Sortable columns with `aria-sort`
- Mobile breakpoint: switches to card-stack per UX spec
- Empty state: "No subscriptions yet."

### T3.7 — `<RevenueSection>` component
- File: `components/admin/billing/revenue-section.tsx`
- Props: `{ data: RevenueData, loading, error }`
- 4-up KPI tile row (MRR / ARR / Churn / New Trials)
- 30d MRR sparkline below with 4-date X-axis labels (per UX spec exception to Phase 1 hide-axes rule)

### Wave 3 acceptance
- All primitives type-check and render in isolation
- Loading / empty / error states per spec
- a11y: keyboard nav, focus rings, ARIA on sortable headers + status badges

---

## Wave 4 — Frontend pages

### T4.1 — Subscriptions list page
- File: `app/admin/apps/mark8ly/subscriptions/page.tsx`
- Composes `<SubscriptionsTable>` + summary tiles + filter chips
- Fetches via `useSWR("/api/admin/apps/mark8ly/subscriptions?sort=...&filter=...")`
- URL state: sort + filter persisted in querystring (Next.js `useSearchParams`)
- Each row links to `/admin/apps/mark8ly/tenants/{id}`

### T4.2 — Tenant detail Subscription + Margin sections
- File: `components/admin/tenant-detail-layout.tsx` — extend with two new MetricsSection blocks below existing ones
- Fetches via new `useTenantBilling(tenantId)` SWR hook in `lib/admin/use-billing.ts`
- Subscription section composes: `<PlanBadge>`, `<StatusBadge>`, period dates, `<DunningPill>` (if applicable), trial info (if applicable), `<PlanChangeTimeline>`
- Margin section uses `<MarginCard>`
- Both gracefully render "—" when subscription is null (e.g. tenant exists but no subscription row yet)

### T4.3 — Mark8ly Overview Revenue section
- File: `components/admin/product-overview-layout.tsx` — insert `<RevenueSection>` between Business KPIs and Resources per UX spec
- Fetches via new `useProductRevenue(productId, window)` SWR hook
- Conditional on `config.pricingByPlan` being defined (HomeChef etc. without subscriptions: section hidden)

### T4.4 — Subscriptions nav entry
- File: `components/admin/sidebar.tsx` — `mark8lyNav` gets new entry (already covered in T0.2; verify it links correctly)

### Wave 4 acceptance
- Subscriptions list page renders, sorts, filters, and links work
- Tenant detail shows live Subscription + Margin sections
- Overview shows Revenue section with MRR/ARR/Churn
- All three surfaces gracefully degrade when upstream fails (per Phase 1 pattern)

---

## Wave 5 — Visual polish + a11y audit

### T5.1 — Apply impeccable design skills
Run, in this order, against the new pages:
1. `arrange` — layout rhythm and spacing on subscriptions list + new sections
2. `typeset` — typography on the badges, currency display, plan-change timeline
3. `clarify` — copy on plan badges, dunning states, margin honesty text
4. `harden` — empty/error/edge cases (canceled, incomplete, archived tenants)
5. `polish` — alignment, consistency, micro-detail

### T5.2 — Lighthouse a11y run
- Both new surfaces (subscriptions list + tenant detail) score ≥ 95
- Sortable column headers verified with screen reader
- Status/plan badges verified to communicate via text not color alone

### T5.3 — Manual keyboard walkthrough
- Tab through subscriptions list: filter chips, sortable headers, row links, all reachable
- Tenant detail: subscription panel + margin info-icon tooltip reachable

### Wave 5 acceptance
- All design skills applied
- Lighthouse a11y ≥ 95
- Keyboard test passes
- No console errors

---

## Risk-driven sequencing notes

- **Wave 0 must complete before Wave 1.** Without DB grants, even fixture-based tests can't validate against real schema.
- **Wave 1.1 (pricing config)** — block on confirmation from mark8ly product owner OR ship with `// TODO: confirm prices` comment and use clearly-labeled placeholders. Don't block the whole phase.
- **Wave 4.3** depends on Phase 1's `cost-proxy` working — already shipped, no blocker.
- **Wave 5 design polish** gates phase completion.

---

## Definition of done (phase)

- [ ] All Wave 0–5 tasks complete and acceptance criteria met
- [ ] CONTEXT.md acceptance criteria all checked
- [ ] CI green on tesserix-home
- [ ] Deployed to prod (rollout complete on `company` deployment)
- [ ] Pricing constants confirmed with mark8ly product owner OR clearly TODO-flagged
- [ ] One operator can answer "is this tenant economically healthy" in under 10s on the tenant page
- [ ] No mark8ly regressions (no mark8ly code touched — N/A check)
- [ ] PHASE-2-SUMMARY.md written
