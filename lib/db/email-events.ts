// Phase 1 Wave 1.5 — email_events read + write layer.
//
// Writes come from the SendGrid webhook receiver (POST /webhooks/sendgrid).
// Reads come from product/tenant dashboards via getEmailMetrics().
//
// Wave 5 already instrumented every mark8ly send site with custom_args
// for product / tenant_id / kind. Once SendGrid posts the engagement
// event back to /webhooks/sendgrid, this table fills with attributable
// rows and dashboards stop returning zeros.

import { tesserixQuery } from "./tesserix";

export interface EmailEventInput {
  readonly sgEventId: string;
  readonly eventType: string;
  readonly product: string | null;
  readonly tenantId: string | null;
  readonly kind: string | null;
  readonly templateKey: string | null;
  readonly campaignId: string | null;
  readonly leadId: string | null;
  readonly recipient: string | null;
  readonly reason: string | null;
  readonly raw: unknown;
  readonly eventAt: Date;
}

// Bulk insert one batch of events. ON CONFLICT DO NOTHING because
// SendGrid retries (slow ack) re-deliver the same sg_event_id and we
// want the second delivery to be a no-op.
export async function insertEmailEvents(
  events: ReadonlyArray<EmailEventInput>,
): Promise<number> {
  if (events.length === 0) return 0;

  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const e of events) {
    values.push(
      `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb, $${i++})`,
    );
    params.push(
      e.sgEventId,
      e.eventType,
      e.product,
      e.tenantId,
      e.kind,
      e.templateKey,
      e.campaignId,
      e.leadId,
      e.recipient,
      e.reason,
      JSON.stringify(e.raw),
      e.eventAt.toISOString(),
    );
  }
  const sql = `
    INSERT INTO email_events
      (sg_event_id, event_type, product, tenant_id, kind, template_key,
       campaign_id, lead_id, recipient, reason, raw, event_at)
    VALUES ${values.join(", ")}
    ON CONFLICT (sg_event_id) DO NOTHING
  `;
  const res = await tesserixQuery(sql, params);
  return res.rowCount ?? 0;
}

// ─── Aggregation ─────────────────────────────────────────────────────

export interface EmailMetricsRow {
  readonly product: string;
  readonly tenantId: string | null;
  readonly sent: number;
  readonly delivered: number;
  readonly opens: number;
  readonly clicks: number;
  readonly bounces: number;
  readonly drops: number;
  readonly unsubscribes: number;
}

// Aggregate engagement events for a (product, optional tenant) over
// the last `days` window. Returns one row per (product, tenant_id)
// pair. tenantId can be null for cross-tenant events (verification,
// password reset).
export async function aggregateEmailMetrics(opts: {
  product?: string;
  tenantId?: string;
  days?: number;
}): Promise<EmailMetricsRow[]> {
  const days = Math.max(1, Math.min(opts.days ?? 30, 365));
  const filters: string[] = [`event_at > now() - interval '${days} days'`];
  const params: unknown[] = [];
  if (opts.product) {
    params.push(opts.product);
    filters.push(`product = $${params.length}`);
  }
  if (opts.tenantId) {
    params.push(opts.tenantId);
    filters.push(`tenant_id = $${params.length}`);
  }

  // We treat "processed" + "delivered" as separate signals; "sent" is
  // anything that left our system (processed). The dashboard usually
  // shows delivered as the primary success metric.
  const sql = `
    SELECT
      coalesce(product, '')        AS product,
      tenant_id,
      count(*) FILTER (WHERE event_type IN ('processed','delivered'))::bigint AS sent,
      count(*) FILTER (WHERE event_type = 'delivered')::bigint AS delivered,
      count(*) FILTER (WHERE event_type = 'open')::bigint      AS opens,
      count(*) FILTER (WHERE event_type = 'click')::bigint     AS clicks,
      count(*) FILTER (WHERE event_type = 'bounce')::bigint    AS bounces,
      count(*) FILTER (WHERE event_type = 'dropped')::bigint   AS drops,
      count(*) FILTER (WHERE event_type IN ('unsubscribe','group_unsubscribe'))::bigint AS unsubscribes
    FROM email_events
    WHERE ${filters.join(" AND ")}
    GROUP BY product, tenant_id
    ORDER BY delivered DESC NULLS LAST
  `;
  const res = await tesserixQuery<{
    product: string;
    tenant_id: string | null;
    sent: string;
    delivered: string;
    opens: string;
    clicks: string;
    bounces: string;
    drops: string;
    unsubscribes: string;
  }>(sql, params);
  return res.rows.map((r) => ({
    product: r.product,
    tenantId: r.tenant_id,
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    opens: Number(r.opens),
    clicks: Number(r.clicks),
    bounces: Number(r.bounces),
    drops: Number(r.drops),
    unsubscribes: Number(r.unsubscribes),
  }));
}

// Recent events for the notification log (E2). Pagination via simple
// LIMIT — no cursor needed at expected volumes.
export interface EmailEventLogRow {
  readonly id: number;
  readonly sgEventId: string;
  readonly eventType: string;
  readonly product: string | null;
  readonly tenantId: string | null;
  readonly templateKey: string | null;
  readonly recipient: string | null;
  readonly reason: string | null;
  readonly eventAt: string;
}

export async function listRecentEmailEvents(opts: {
  product?: string;
  tenantId?: string;
  limit?: number;
}): Promise<EmailEventLogRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const filters: string[] = [];
  const params: unknown[] = [];
  if (opts.product) {
    params.push(opts.product);
    filters.push(`product = $${params.length}`);
  }
  if (opts.tenantId) {
    params.push(opts.tenantId);
    filters.push(`tenant_id = $${params.length}`);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `
    SELECT id, sg_event_id, event_type, product, tenant_id, template_key,
           recipient, reason, event_at
    FROM email_events
    ${where}
    ORDER BY event_at DESC
    LIMIT ${limit}
  `;
  const res = await tesserixQuery<{
    id: number;
    sg_event_id: string;
    event_type: string;
    product: string | null;
    tenant_id: string | null;
    template_key: string | null;
    recipient: string | null;
    reason: string | null;
    event_at: string;
  }>(sql, params);
  return res.rows.map((r) => ({
    id: r.id,
    sgEventId: r.sg_event_id,
    eventType: r.event_type,
    product: r.product,
    tenantId: r.tenant_id,
    templateKey: r.template_key,
    recipient: r.recipient,
    reason: r.reason,
    eventAt: r.event_at,
  }));
}
