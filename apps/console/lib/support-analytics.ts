import { PlatformApiError } from "./platform-api";

/**
 * Platform-wide support analytics — otto's cross-tenant rollup, read through
 * apps/web's `/api/admin/analytics/support` proxy.
 *
 * The console goes through the proxy rather than calling otto directly for one
 * reason that is easy to lose: the proxy enriches `by_tenant`'s raw ids with
 * display names from the **mark8ly** database, which the console has no
 * connection to. Calling otto directly would render a column of UUIDs.
 *
 * Parsed strictly, like `lib/tickets.ts`: a malformed payload throws rather
 * than coercing to zero. A support dashboard that quietly reads 0% CSAT
 * because a field was renamed upstream is worse than one that says it broke.
 */

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformApiError(`support analytics: ${path} is missing`);
  }
  return value as Record<string, unknown>;
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlatformApiError(`support analytics: ${path} is not a number`);
  }
  return value;
}

/**
 * A `key -> count` bucket map.
 *
 * `null` is accepted as "no buckets" and nothing else is: otto is Go, and a nil
 * map marshals to `null`, not `{}`, so `"by_reason": null` is a real payload
 * from a real deployment rather than a malformed one. Any other non-object —
 * a string, a number, an array — is a contract change and throws.
 */
function counts(value: unknown, path: string): Record<string, number> {
  if (value === null || value === undefined) {
    return {};
  }
  const record = obj(value, path);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    out[key] = num(raw, `${path}.${key}`);
  }
  return out;
}

/** The proxy's id → display-name enrichment. Absent ids fall back to the id. */
function names(value: unknown, path: string): Record<string, string> {
  if (value === null || value === undefined) {
    return {};
  }
  const record = obj(value, path);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== "string") {
      throw new PlatformApiError(`support analytics: ${path}.${key} is not a string`);
    }
    out[key] = raw;
  }
  return out;
}

/** One row of a breakdown, already ranked. */
export interface SupportBreakdownRow {
  /** The raw bucket key — a status, a reason, a tenant id. */
  readonly key: string;
  /** What to show a human: the resolved tenant name where there is one. */
  readonly label: string;
  readonly count: number;
  /** This row's share of its own breakdown, 0–1. Not of `total`: `by_reason`
   *  only covers conversations that were categorised, so dividing by `total`
   *  would quietly under-report every reason. */
  readonly share: number;
}

export interface SupportAnalytics {
  readonly total: number;
  readonly open: number;
  readonly escalated: number;
  readonly aiResolved: number;
  readonly avgResolutionSeconds: number;
  readonly csat: number;
  readonly resolvedRate: number;
  readonly feedbackCount: number;
  readonly byStatus: readonly SupportBreakdownRow[];
  readonly byReason: readonly SupportBreakdownRow[];
  readonly byTenant: readonly SupportBreakdownRow[];
}

/**
 * Rank a bucket map, biggest first.
 *
 * Ties break on the key so the order is stable across reads — an unstable
 * ranking makes two equal buckets swap places on every navigation, which reads
 * as movement in the data when nothing has changed.
 */
function rank(
  buckets: Record<string, number>,
  labels: Record<string, string> = {},
): SupportBreakdownRow[] {
  const entries = Object.entries(buckets);
  const sum = entries.reduce((acc, [, count]) => acc + count, 0);
  return entries
    .map(([key, count]) => ({
      key,
      label: labels[key] ?? key,
      count,
      share: sum === 0 ? 0 : count / sum,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function parseSupportAnalytics(json: unknown): SupportAnalytics {
  const root = obj(json, "response");
  const tenantNames = names(root.tenant_names, "tenant_names");
  return {
    total: num(root.total, "total"),
    open: num(root.open, "open"),
    escalated: num(root.escalated, "escalated"),
    aiResolved: num(root.ai_resolved, "ai_resolved"),
    avgResolutionSeconds: num(root.avg_resolution_seconds, "avg_resolution_seconds"),
    csat: num(root.csat, "csat"),
    resolvedRate: num(root.resolved_rate, "resolved_rate"),
    feedbackCount: num(root.feedback_count, "feedback_count"),
    byStatus: rank(counts(root.by_status, "by_status")),
    byReason: rank(counts(root.by_reason, "by_reason")),
    byTenant: rank(counts(root.by_tenant, "by_tenant"), tenantNames),
  };
}

/** Coarse duration, matching the queue's vocabulary rather than exact seconds. */
export function formatResolutionTime(seconds: number): string {
  if (seconds <= 0) {
    return "—";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

/** `n` as a whole-percent share of `d`. A zero denominator is 0%, not NaN%. */
export function formatShare(n: number, d: number): string {
  return `${d === 0 ? 0 : Math.round((n / d) * 100)}%`;
}

/**
 * CSAT reads as a rating out of five, and only when somebody actually rated.
 * A `0.0 / 5` from an empty feedback set looks like a catastrophic score.
 */
export function formatCsat(csat: number, feedbackCount: number): string {
  return feedbackCount === 0 || csat === 0 ? "—" : `${csat.toFixed(1)} / 5`;
}

/** Same guard as CSAT: an unrated period is unmeasured, not 0%. */
export function formatResolvedRate(rate: number, feedbackCount: number): string {
  return feedbackCount === 0 ? "—" : `${Math.round(rate * 100)}%`;
}
