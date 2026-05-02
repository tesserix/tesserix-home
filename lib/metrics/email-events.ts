// Email metrics aggregator. Wave 1.5: backed by tesserix_admin.email_events
// populated via /webhooks/sendgrid. Until the SendGrid signing key lands
// in GSM (and SENDGRID_WEBHOOK_PUBLIC_KEY is set), the table will be
// empty and these functions return zeros — same shape as the prior stub
// so dashboards don't change behaviour pre-key-rotation.

import { aggregateEmailMetrics } from "@/lib/db/email-events";
import { logger } from "@/lib/logger";

export interface EmailMetrics {
  readonly sent: number;
  readonly delivered: number;
  readonly opens: number;
  readonly bounces: number;
  readonly unsubscribes: number;
  readonly dropped: number;
}

export interface EmailMetricsFilters {
  readonly product: string;
  readonly tenantId?: string;
  readonly days: number;
}

const ZERO: EmailMetrics = {
  sent: 0,
  delivered: 0,
  opens: 0,
  bounces: 0,
  unsubscribes: 0,
  dropped: 0,
};

export async function getEmailMetrics(
  filters: EmailMetricsFilters,
): Promise<EmailMetrics> {
  try {
    const rows = await aggregateEmailMetrics({
      product: filters.product,
      tenantId: filters.tenantId,
      days: filters.days,
    });
    if (rows.length === 0) return ZERO;
    return rows.reduce<EmailMetrics>(
      (acc, r) => ({
        sent: acc.sent + r.sent,
        delivered: acc.delivered + r.delivered,
        opens: acc.opens + r.opens,
        bounces: acc.bounces + r.bounces,
        unsubscribes: acc.unsubscribes + r.unsubscribes,
        dropped: acc.dropped + r.drops,
      }),
      ZERO,
    );
  } catch (err) {
    logger.warn("[email-events] aggregate failed; returning zeros", {
      err: err instanceof Error ? err.message : String(err),
    });
    return ZERO;
  }
}
