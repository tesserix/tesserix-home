// Email events client. Phase 1 stub: returns zeros until Wave 1.5 lands
// the SendGrid Event Webhook receiver in notification-service. Once that
// ships, swap the stub for an HTTP call to
//   GET notification-service/internal/email-events/aggregate
// keyed by product (+ optional tenant_id) and a days window.

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

export async function getEmailMetrics(_filters: EmailMetricsFilters): Promise<EmailMetrics> {
  // Stub. Returns zeros so the dashboard shape is stable; real source
  // wires in once notification-service.email_events is populated.
  return ZERO;
}
