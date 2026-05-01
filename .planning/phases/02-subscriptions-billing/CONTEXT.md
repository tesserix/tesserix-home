# Phase 2: Subscriptions, Dunning + Trial Management — Context

**Status:** Ready for planning
**Source:** Backlog conversation 2026-05-01, reordered ahead of comms because A1 + L2 = margin-per-tenant which is daily-use
**Surfaces:** `/admin/apps/mark8ly` (Overview gets Revenue section), `/admin/apps/mark8ly/tenants/[id]` (gets Subscription + Margin sections), `/admin/apps/mark8ly/subscriptions` (NEW — list view)
**Backlog refs:** A1, N1, G1
**Depends on:** Phase 1 (cost-proxy used for Margin signal)

---

## Phase boundary

Add subscription, dunning, and revenue visibility to the super-admin tool. Read-only across all data sources. Zero changes to mark8ly services.

**In scope:**
- A1 (tenant): Subscription panel on tenant detail — plan, status, current period, dunning state, plan-change history, lifetime revenue
- A1 (product): New `/admin/apps/mark8ly/subscriptions` page — sortable list of all tenants' billing health with summary tiles (Total MRR, Trial count, Past-due count, Cancelled-this-month)
- N1: Trial management — trial filter on subscriptions list, trial-specific columns (days remaining, conversion likelihood heuristic)
- G1: Revenue section on Mark8ly Overview — MRR, ARR (extrapolated), 30d trend, churn rate, new trials
- Margin section on tenant detail: `revenue − infra_cost_proxy` combining Phase 2 A1 with Phase 1 L2

**Out of scope:**
- Stripe Connect / merchant payment flows (Phase 4+)
- Configurable billing/secrets (C1, parked)
- Writing back to subscriptions (mutations) — read-only only
- Customer-facing pricing pages

---

## Locked decisions

### Architecture
- Same FR pattern as Phase 1 — `tesserix_admin` role gets new SELECT grants on mark8ly tables.
- New shared lib `lib/db/mark8ly-billing.ts` for query helpers.
- New API routes:
  - `GET /api/admin/apps/[product]/subscriptions?sort=...&filter=...` — list view
  - `GET /api/admin/apps/[product]/tenants/[id]/billing` — per-tenant subscription detail
  - `GET /api/admin/apps/[product]/revenue?window=30d` — aggregate MRR/ARR/churn for Overview tile
- Browser proxies through tesserix-home API; never calls mark8ly DB directly.
- 60-second in-memory cache pattern from Phase 1 reused for all three routes.

### Data model
**`store_subscriptions` (canonical)**
```
id, tenant_id, store_id
stripe_customer_id, stripe_subscription_id
plan: 'trial'|'starter'|'studio'|'pro'|'marketplace'
status: 'active'|'trialing'|'past_due'|'canceled'|'incomplete'|'unpaid'|... (Stripe lifecycle)
current_period_start, current_period_end
cancel_at_period_end
created_at, updated_at
```

**Trial detection:** UNION of `plan='trial'` (free tier) AND `status='trialing'` (Stripe trial period — could be on a paid plan).

**`subscription_plan_change_audit`:** plan history timeline. Columns: `from_plan`, `to_plan`, `from_period`, `to_period`, `action`, `billing_currency`, `proration_cents`, `actor`, `effective_at`.

**`stripe_webhook_events`:** invoice payment events; dunning state derives from `event_type` history (`invoice.payment_failed`, `invoice.payment_succeeded`, `invoice.upcoming`).

**`billing_archive`:** post-deletion 7yr retention; `total_revenue_usd` is canonical lifetime revenue for archived tenants.

### Per-plan pricing
**No pricing table in mark8ly DB.** Pricing lives in `lib/products/configs.ts`:
```ts
mark8ly.pricingByPlan = {
  trial: 0,
  starter: 29,    // PLACEHOLDER — confirm with mark8ly product owner
  studio: 79,
  pro: 149,
  marketplace: 299,
}
mark8ly.pricingCurrency = "USD"
```

MRR = sum over `status IN ('active','trialing','past_due')` of `pricingByPlan[plan]`. Trialing subs count toward MRR? **No.** Use only `status='active'` for MRR (trialing not yet generating revenue). Document inline.

### Trial conversion likelihood (N1)
**Heuristic only**, not ML. Score = blend of:
- Days into trial (later = higher likelihood, capped at 0.7)
- Activity signal: orders count > 0 in trial period (binary boost +0.2)
- Login recency: last_seen within 7d (boost +0.1)

Output: `low | medium | high` bucket. Show as a tag on trial rows, not a percentage. Clearly label as "heuristic" in tooltip.

### Currency
- `store_subscriptions` doesn't carry currency. Pricing config in tesserix-home is USD-only for Phase 2.
- Display USD natively with `Intl.NumberFormat`.
- Plan changes log `billing_currency` per-row — surface in plan-change history, but Phase 2 doesn't convert.
- Future: tooltip showing "USD ≈ AUD" if a daily rate becomes available (Phase 4+).

### Margin section
- `monthlyMargin = monthlyRevenue − monthlyInfraCost`
- `monthlyRevenue` from `store_subscriptions.plan` × pricing config
- `monthlyInfraCost` from Phase 1 `cost-proxy.computeTenantCostShare(...)` with window=30d
- Negative margin → red primary value (loss-making tenant). Positive margin → neutral primary value (growth-context-dependent).
- Same "Estimated" honesty pattern as Phase 1 cost-proxy: word in title + info-icon tooltip with methodology.

### Auth & secrets
- **No new secrets.** Reuses existing `mark8ly-platform-admin` Postgres role.
- New SELECT grants on `marketplace.{store_subscriptions, stripe_webhook_events, subscription_plan_change_audit, billing_archive}` per `tesserix-k8s/docs/cross-db-admin.md` runbook.

---

## Resolved decisions

| # | Decision | Source |
|---|---|---|
| Q1 | Trial detection: union of `plan='trial'` and `status='trialing'` | `000041_subscription_plan_v2_rename.up.sql` + `000042_subscription_status_v2_expand.up.sql` |
| Q2 | Per-plan pricing in `ProductConfig`, not a DB table | grep — no `plan_pricing` table found in mark8ly migrations |
| Q3 | Currency: USD natively from pricing config; track per-change in plan-change-audit but don't convert | `000050` schema |
| Q4 | Margin shown on tenant detail only, not list-view column | List view would require N parallel cost-proxy calls — too expensive |
| Q5 | Conversion likelihood: heuristic bucket (low/medium/high), not ML | Acceptable approximation for an admin tool |
| Q6 | Cross-DB SELECT grants needed on: `store_subscriptions`, `stripe_webhook_events`, `subscription_plan_change_audit`, `billing_archive` | Schema review |

---

## Canonical references

### Phase 2 directory
- `UX-SPEC.md` — page layouts and component specs

### Phase 1 (foundation we build on)
- `.planning/phases/01-resources-cost-dashboards/CONTEXT.md` — pattern reference
- `lib/metrics/cost-proxy.ts` — cost-share calculator reused for Margin
- `components/admin/metrics/` — primitives reused (KpiTile, MetricsSection, RefreshControl)
- `lib/products/types.ts` — extended with `pricingByPlan` + `pricingCurrency`

### tesserix-k8s
- `docs/cross-db-admin.md` — Postgres SELECT grant runbook

### mark8ly migrations (reference)
- `000015_subscriptions.up.sql` — base `store_subscriptions` table
- `000041_subscription_plan_v2_rename.up.sql` — plan enum
- `000042_subscription_status_v2_expand.up.sql` — status enum (incl. `trialing`)
- `000043_stripe_webhook_events.up.sql` — webhook events table
- `000044_subscription_arbitrage_audit.up.sql` — fraud/pricing flags (out of scope, but exists)
- `000046_billing_archive.up.sql` — post-deletion 7yr retention
- `000050_subscription_plan_change_audit.up.sql` — plan history

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Pricing config drifts from mark8ly's actual Stripe prices | Med | Pricing constants live in `ProductConfig`; document the source of truth (Stripe console) and the procedure to update; revisit when mark8ly publishes a `pricing.json` file we can fetch |
| MRR over/under-counts due to status edge cases | Low | Acceptance test: sum-by-status for known fixtures; only count `active` toward MRR |
| Margin calculation misleading on day-1 (trial tenants have $0 revenue but >$0 cost = looks negative) | Med | UI labels "trial" tenants distinctly; margin section either hides for trialing or shows "Trial — n/a yet" |
| Cost-proxy upstream (Prom + OpenCost) failing breaks Margin | Low | Same graceful-degradation as Phase 1: section shows partial; missing inputs default to null with explicit "—" |
| `billing_archive` rows with `total_revenue_usd = NULL` for partial archives | Low | Coalesce to 0 in queries; show "—" in UI when null |

---

## Acceptance criteria (phase-level)

- [ ] Mark8ly Overview shows Revenue section: MRR, ARR, 30d trend, churn rate, new trials
- [ ] Tenant detail shows Subscription section with plan, status, period, dunning (if applicable), trial info (if applicable), plan-change history
- [ ] Tenant detail shows Margin section combining Phase 1 cost-proxy with Phase 2 revenue, with "Estimated" honesty pattern
- [ ] New `/admin/apps/mark8ly/subscriptions` page: sortable list, filter chips (All / Active / Trial / Past-due / Cancelled), summary tiles
- [ ] Sidebar Mark8ly rail gets new "Subscriptions" entry
- [ ] All metrics load via tesserix-home API routes (browser never sees mark8ly DB directly)
- [ ] Pages take a `ProductConfig` so HomeChef etc. reuse layouts; if a product has no `pricingByPlan` defined, billing UI gracefully hides
- [ ] Loading / empty / stale / error states styled per UX spec
- [ ] WCAG 2.1 AA: keyboard nav, focus rings, sortable column headers (`aria-sort`), screen-reader friendly badges
- [ ] Type check passes (`tsc --noEmit`); lint clean
- [ ] No new browser console errors
- [ ] Lighthouse a11y ≥ 95 on both new surfaces
