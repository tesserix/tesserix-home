// Cross-DB read helpers for mark8ly's billing surfaces.
// Read-only via the existing tesserix_admin Postgres role. SELECT grants
// for the four tables below are required (see tesserix-k8s/docs/cross-db-admin.md).

import { mark8lyQuery } from "./mark8ly";

export interface SubscriptionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly store_id: string;
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly plan: string;
  readonly status: string;
  readonly current_period_start: string | null;
  readonly current_period_end: string | null;
  readonly cancel_at_period_end: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PlanChangeRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly from_plan: string;
  readonly to_plan: string;
  readonly from_period: string;
  readonly to_period: string;
  readonly action: string;
  readonly billing_currency: string;
  readonly proration_cents: string | null;
  readonly actor: string;
  readonly reason: string | null;
  readonly effective_at: string;
}

export interface InvoiceEventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly tenant_id: string | null;
  readonly received_at: string;
  readonly processed_at: string | null;
  readonly processing_error: string | null;
  readonly retry_count: number;
  readonly manual_review_required: boolean;
}

export interface SubscriptionListFilter {
  readonly plan?: string;
  readonly status?: string;
  readonly trialOnly?: boolean;
  readonly dunningOnly?: boolean;
  readonly limit?: number;
}

const DUNNING_STATUSES: ReadonlyArray<string> = ["past_due", "unpaid", "incomplete"];

export async function getSubscription(tenantId: string): Promise<SubscriptionRow | null> {
  const res = await mark8lyQuery<SubscriptionRow>(
    "marketplace_api",
    `SELECT id, tenant_id, store_id, stripe_customer_id, stripe_subscription_id,
            plan, status, current_period_start, current_period_end,
            cancel_at_period_end, created_at, updated_at
     FROM store_subscriptions
     WHERE tenant_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [tenantId],
  );
  return res.rows[0] ?? null;
}

export async function listSubscriptions(filter: SubscriptionListFilter = {}): Promise<SubscriptionRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filter.plan) {
    where.push(`plan = $${i++}`);
    params.push(filter.plan);
  }
  if (filter.status) {
    where.push(`status = $${i++}`);
    params.push(filter.status);
  }
  if (filter.trialOnly) {
    where.push(`(plan = 'trial' OR status = 'trialing')`);
  }
  if (filter.dunningOnly) {
    where.push(`status = ANY($${i++})`);
    params.push(DUNNING_STATUSES);
  }

  const limit = Math.min(filter.limit ?? 200, 1000);
  const sql = `
    SELECT id, tenant_id, store_id, stripe_customer_id, stripe_subscription_id,
           plan, status, current_period_start, current_period_end,
           cancel_at_period_end, created_at, updated_at
    FROM store_subscriptions
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY current_period_end ASC NULLS LAST
    LIMIT ${limit}
  `;

  const res = await mark8lyQuery<SubscriptionRow>("marketplace_api", sql, params);
  return res.rows;
}

export async function getPlanChangeHistory(tenantId: string, limit = 10): Promise<PlanChangeRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const res = await mark8lyQuery<PlanChangeRow>(
    "marketplace_api",
    `SELECT id, tenant_id, from_plan, to_plan, from_period, to_period,
            action, billing_currency, proration_cents, actor, reason, effective_at
     FROM subscription_plan_change_audit
     WHERE tenant_id = $1
     ORDER BY effective_at DESC
     LIMIT ${safeLimit}`,
    [tenantId],
  );
  return res.rows;
}

export async function getRecentInvoiceEvents(tenantId: string, limit = 20): Promise<InvoiceEventRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const res = await mark8lyQuery<InvoiceEventRow>(
    "marketplace_api",
    `SELECT event_id, event_type, tenant_id, received_at, processed_at,
            processing_error, retry_count, manual_review_required
     FROM stripe_webhook_events
     WHERE tenant_id = $1 AND event_type LIKE 'invoice.%'
     ORDER BY received_at DESC
     LIMIT ${safeLimit}`,
    [tenantId],
  );
  return res.rows;
}

// Lifetime revenue: sum of `invoice.payment_succeeded` amounts from
// stripe_webhook_events.payload (Stripe sends amounts in cents). Falls
// back to billing_archive.total_revenue_usd for archived (deleted)
// tenants. Returns USD cents as a number.
export async function getLifetimeRevenueCents(tenantId: string): Promise<number> {
  const liveRes = await mark8lyQuery<{ total: string | null }>(
    "marketplace_api",
    `SELECT COALESCE(SUM(
       (payload->'data'->'object'->>'amount_paid')::bigint
     ), 0)::text AS total
     FROM stripe_webhook_events
     WHERE tenant_id = $1
       AND event_type = 'invoice.payment_succeeded'`,
    [tenantId],
  );
  const liveCents = Number(liveRes.rows[0]?.total ?? 0);
  if (liveCents > 0) return liveCents;

  // Fallback: archived tenants
  const archiveRes = await mark8lyQuery<{ total_revenue_usd: string | null }>(
    "marketplace_api",
    `SELECT total_revenue_usd::text
     FROM billing_archive
     WHERE original_tenant_id = $1
     ORDER BY hard_deleted_at DESC
     LIMIT 1`,
    [tenantId],
  );
  const archiveUsd = Number(archiveRes.rows[0]?.total_revenue_usd ?? 0);
  return Math.round(archiveUsd * 100);
}

// Quick aggregate counts for the subscriptions list summary tiles.
export interface SubscriptionsSummary {
  readonly totalActive: number;
  readonly trialing: number;
  readonly pastDue: number;
  readonly cancelledThisMonth: number;
}

export async function getSubscriptionsSummary(): Promise<SubscriptionsSummary> {
  const res = await mark8lyQuery<{
    total_active: string;
    trialing: string;
    past_due: string;
    cancelled_this_month: string;
  }>(
    "marketplace_api",
    `SELECT
       count(*) FILTER (WHERE status = 'active')::bigint AS total_active,
       count(*) FILTER (WHERE plan = 'trial' OR status = 'trialing')::bigint AS trialing,
       count(*) FILTER (WHERE status IN ('past_due','unpaid','incomplete'))::bigint AS past_due,
       count(*) FILTER (WHERE status = 'canceled' AND updated_at >= date_trunc('month', now()))::bigint AS cancelled_this_month
     FROM store_subscriptions`,
  );
  const r = res.rows[0];
  return {
    totalActive: Number(r?.total_active ?? 0),
    trialing: Number(r?.trialing ?? 0),
    pastDue: Number(r?.past_due ?? 0),
    cancelledThisMonth: Number(r?.cancelled_this_month ?? 0),
  };
}

export async function countNewTrialsSince(daysAgo: number): Promise<number> {
  const res = await mark8lyQuery<{ n: string }>(
    "marketplace_api",
    `SELECT count(*)::bigint AS n
     FROM store_subscriptions
     WHERE (plan = 'trial' OR status = 'trialing')
       AND created_at >= now() - ($1 || ' days')::interval`,
    [String(daysAgo)],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function countCancelledSince(daysAgo: number): Promise<number> {
  const res = await mark8lyQuery<{ n: string }>(
    "marketplace_api",
    `SELECT count(*)::bigint AS n
     FROM store_subscriptions
     WHERE status = 'canceled'
       AND updated_at >= now() - ($1 || ' days')::interval`,
    [String(daysAgo)],
  );
  return Number(res.rows[0]?.n ?? 0);
}
