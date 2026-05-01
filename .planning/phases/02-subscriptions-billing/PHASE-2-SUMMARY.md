# Phase 2 Summary — Subscriptions, Dunning + Trial Management

**Status:** Functionally complete and live in production. ✅
**Closed:** 2026-05-01
**Surfaces live:** `/admin/apps/mark8ly` (Revenue tile), `/admin/apps/mark8ly/tenants/{id}` (Subscription + Margin), `/admin/apps/mark8ly/subscriptions` (NEW list view)

---

## What shipped

| Wave | Scope | Status |
|---|---|---|
| 0 | Sidebar nav (Subscriptions in Mark8ly rail); DB grants documented | ✅ Code; ⏳ Grants user-side |
| 1 | Backend: `lib/db/mark8ly-billing.ts`, `lib/metrics/{revenue,margin,trial-likelihood}.ts`; `ProductConfig.pricingByPlan` extension | ✅ |
| 2 | API routes: `/api/admin/apps/[product]/{subscriptions,revenue}` + `/tenants/[id]/billing` | ✅ |
| 3 | Primitives: `PlanBadge`, `StatusBadge`, `DunningPill`, `PlanChangeTimeline`, `MarginCard`, `SubscriptionsTable`, `RevenueSection`; SWR hooks in `lib/admin/use-billing.ts` | ✅ |
| 4 | Pages: `<SubscriptionsPageLayout>` (NEW route), tenant detail Subscription + Margin sections, Overview Revenue section | ✅ |
| 5 | Polish + a11y | Inherits Phase 1 patterns (TooltipProvider, error boundary, refresh toast); spot-fix as needed |

---

## What works today (assuming DB grants run)

- **Mark8ly Overview** gets a **Revenue** tile row at the top: MRR, ARR, Churn rate (30d), New trials (30d).
- **Tenant detail** gets two new sections:
  - **Subscription**: plan + status badges, dunning pill (when applicable), period dates, trial info (days remaining + likelihood), cancel-at-period-end flag, plan-change history timeline, lifetime revenue.
  - **Estimated margin**: revenue − infra cost (from Phase 1 cost-proxy), with the same "Estimated" honesty pattern; negative margin renders red, trial tenants get a "—" with explanation.
- **`/admin/apps/mark8ly/subscriptions`** — new list page with summary tiles (Total MRR, Trial, Past due, Cancelled this month), filter chips (All/Active/Trial/Past due/Cancelled), sortable columns, mobile card-stack support.

## What's empty until you act

The whole billing surface gracefully returns empty (`—`) until **one runbook step**:

```sql
GRANT SELECT ON marketplace.store_subscriptions,
                marketplace.stripe_webhook_events,
                marketplace.subscription_plan_change_audit,
                marketplace.billing_archive
TO tesserix_admin;
```

Per `tesserix-k8s/docs/cross-db-admin.md`. After this runs, all three surfaces hydrate on next refresh. No code changes required.

## Pricing constants

`lib/products/configs.ts` has placeholder pricing:
```
trial: 0 · starter: $29 · studio: $79 · pro: $149 · marketplace: $299  (USD)
```
Mark these as the source of truth or update from Stripe before relying on MRR/ARR numbers in reports.

---

## Phase 2 commits

| SHA | What |
|---|---|
| `eb6b466` | Wave 0+1: backend foundations + sidebar nav |
| `f0c6fa4` | Wave 2: API routes |
| `37a8157` | Wave 3: billing primitives + SWR hooks |
| `99fdd22` | Wave 4: subscriptions list page + tenant Subscription/Margin + Overview Revenue |

4 commits, ~1300 lines of code in tesserix-home.

---

## Patterns added to the codebase (Phase 3+ inherits)

- **Optional `ProductConfig` extension** — `pricingByPlan?` lets future products opt in/out cleanly. HomeChef can ship without billing UI showing.
- **Federated read pattern** extended to billing tables; same `tesserix_admin` role.
- **`computeTenantMargin`** — reusable revenue minus cost-proxy formula for any product with both signals.
- **Status/Plan badge taxonomy** — color/weight conventions established; reuse for tickets, audit logs, etc.
- **Filter-chip pattern** on list views (mirroring tenants list); ready for Tickets / Audit Logs in Phase 3.
- **Plan change timeline** — vertical timeline with collapse/expand; reusable for any audit-log-ish list.

## Surprises / learnings

- **Pricing is in code, not DB.** mark8ly has no `plan_pricing` table. Pricing lives in tesserix-home `ProductConfig` because mark8ly's source of truth is Stripe directly. Trade-off: drift risk, but DB-table pricing would also drift unless we sync from Stripe nightly.
- **`status='trialing'` ≠ `plan='trial'`.** Trialing is a Stripe lifecycle state (could be on any paid plan during a Stripe-managed trial). Plan='trial' is mark8ly's free tier. Surface both in trial detection (UNION) since they have different semantics but overlap in operator intent.
- **Dunning state derived from status, not a column.** `past_due` = retrying; `unpaid` = retries exhausted; `incomplete` = never resolved. No dedicated dunning column. UI displays `<DunningPill>` with the inferred state.
- **Margin window math** — Phase 1 cost-proxy returns absolute cost over a window; subscription pricing is per-month. Used `WINDOW_TO_MONTH_RATIO` to scale revenue to match cost window. Document inline.

## Phase 3 inherits (unchanged plan)

Phase 3 = Templates Registry + Lead Marketing Send (B1, B2). New plan in `.planning/phases/03-templates-marketing/` (not yet written). No mark8ly send-path changes in Phase 3 either — read-only template registry as canon-of-truth.
