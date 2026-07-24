// E5 — Outbox events monitor.
//
// Federated read across mark8ly's two outbox tables. The schemas differ
// because the two services were built at different times:
//
// - mark8ly_platform_api.outbox_events
//     id BIGSERIAL, kind, payload, status (pending/in_flight/completed/dead),
//     attempts, last_error, next_attempt_at, created_at, completed_at
//     "Stuck" = status IN ('pending','in_flight') AND
//               next_attempt_at < now() - threshold
//     Permanent failure = status='dead'
//
// - mark8ly_marketplace_api.outbox_events
//     id uuid, tenant_id, aggregate, aggregate_id, event_type, payload,
//     created_at, published_at, error
//     "Stuck" = published_at IS NULL AND created_at < now() - threshold
//     Permanent failure = no explicit dead state — surfaces via long age + error
//
// We normalize both into a common OutboxRow shape so the UI can render a
// single combined table, but expose per-database aggregates for the KPI tiles
// because the operator needs to know which side is stuck.

import { mark8lyQuery } from "./mark8ly";

export type OutboxDatabase = "platform_api" | "marketplace_api";
export type OutboxStatus = "pending" | "in_flight" | "completed" | "dead";

const STUCK_AFTER_SECONDS = 5 * 60; // 5 minutes — generous; drainers tick faster
const RECENT_LIMIT = 50;

export interface OutboxRow {
  readonly database: OutboxDatabase;
  readonly id: string;
  readonly kind: string;
  readonly status: OutboxStatus;
  readonly attempts: number | null;
  readonly ageSeconds: number;
  readonly lastError: string | null;
  readonly tenantId: string | null;
  readonly aggregate: string | null;
  readonly createdAt: string;
}

export interface OutboxDatabaseSummary {
  readonly database: OutboxDatabase;
  readonly available: boolean;
  readonly pending: number;
  readonly inFlight: number;
  readonly stuck: number;
  readonly dead: number;
  readonly oldestPendingAgeSeconds: number | null;
  readonly errorMessage: string | null;
}

export interface OutboxOverview {
  readonly summaries: ReadonlyArray<OutboxDatabaseSummary>;
  readonly recent: ReadonlyArray<OutboxRow>;
  readonly generatedAt: string;
}

interface PlatformSummaryRow {
  pending: string | null;
  in_flight: string | null;
  dead: string | null;
  stuck: string | null;
  oldest_age: string | null;
}

interface MarketplaceSummaryRow {
  pending: string | null;
  stuck: string | null;
  oldest_age: string | null;
}

interface PlatformRecentRow {
  id: string;
  kind: string;
  status: OutboxStatus;
  attempts: number;
  age_seconds: string;
  last_error: string | null;
  created_at: string;
}

interface MarketplaceRecentRow {
  id: string;
  tenant_id: string;
  aggregate: string;
  event_type: string;
  age_seconds: string;
  error: string | null;
  created_at: string;
}

async function getPlatformSummary(): Promise<OutboxDatabaseSummary> {
  try {
    const sql = `
      SELECT
        count(*) FILTER (WHERE status = 'pending')::bigint   AS pending,
        count(*) FILTER (WHERE status = 'in_flight')::bigint AS in_flight,
        count(*) FILTER (WHERE status = 'dead')::bigint      AS dead,
        count(*) FILTER (
          WHERE status IN ('pending','in_flight')
            AND created_at < now() - interval '${STUCK_AFTER_SECONDS} seconds'
        )::bigint                                            AS stuck,
        EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending')))::bigint
                                                             AS oldest_age
      FROM outbox_events
    `;
    const res = await mark8lyQuery<PlatformSummaryRow>("platform_api", sql);
    const r = res.rows[0];
    return {
      database: "platform_api",
      available: true,
      pending: Number(r?.pending ?? 0),
      inFlight: Number(r?.in_flight ?? 0),
      stuck: Number(r?.stuck ?? 0),
      dead: Number(r?.dead ?? 0),
      oldestPendingAgeSeconds: r?.oldest_age ? Number(r.oldest_age) : null,
      errorMessage: null,
    };
  } catch (err) {
    return {
      database: "platform_api",
      available: false,
      pending: 0,
      inFlight: 0,
      stuck: 0,
      dead: 0,
      oldestPendingAgeSeconds: null,
      errorMessage: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

async function getMarketplaceSummary(): Promise<OutboxDatabaseSummary> {
  try {
    const sql = `
      SELECT
        count(*) FILTER (WHERE published_at IS NULL)::bigint AS pending,
        count(*) FILTER (
          WHERE published_at IS NULL
            AND created_at < now() - interval '${STUCK_AFTER_SECONDS} seconds'
        )::bigint                                            AS stuck,
        EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE published_at IS NULL)))::bigint
                                                             AS oldest_age
      FROM outbox_events
    `;
    const res = await mark8lyQuery<MarketplaceSummaryRow>("marketplace_api", sql);
    const r = res.rows[0];
    return {
      database: "marketplace_api",
      available: true,
      pending: Number(r?.pending ?? 0),
      // marketplace schema has no in_flight or dead concept
      inFlight: 0,
      stuck: Number(r?.stuck ?? 0),
      dead: 0,
      oldestPendingAgeSeconds: r?.oldest_age ? Number(r.oldest_age) : null,
      errorMessage: null,
    };
  } catch (err) {
    return {
      database: "marketplace_api",
      available: false,
      pending: 0,
      inFlight: 0,
      stuck: 0,
      dead: 0,
      oldestPendingAgeSeconds: null,
      errorMessage: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

async function getPlatformRecentStuck(): Promise<OutboxRow[]> {
  try {
    const sql = `
      SELECT
        id::text                                            AS id,
        kind,
        status,
        attempts,
        EXTRACT(EPOCH FROM (now() - created_at))::bigint    AS age_seconds,
        last_error,
        created_at
      FROM outbox_events
      WHERE status = 'dead'
         OR (status IN ('pending','in_flight')
             AND created_at < now() - interval '${STUCK_AFTER_SECONDS} seconds')
      ORDER BY created_at ASC
      LIMIT ${RECENT_LIMIT}
    `;
    const res = await mark8lyQuery<PlatformRecentRow>("platform_api", sql);
    return res.rows.map((r) => ({
      database: "platform_api",
      id: r.id,
      kind: r.kind,
      status: r.status,
      attempts: r.attempts,
      ageSeconds: Number(r.age_seconds),
      lastError: r.last_error,
      tenantId: null,
      aggregate: null,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

async function getMarketplaceRecentStuck(): Promise<OutboxRow[]> {
  try {
    const sql = `
      SELECT
        id::text                                            AS id,
        tenant_id::text                                     AS tenant_id,
        aggregate,
        event_type,
        EXTRACT(EPOCH FROM (now() - created_at))::bigint    AS age_seconds,
        error,
        created_at
      FROM outbox_events
      WHERE published_at IS NULL
        AND created_at < now() - interval '${STUCK_AFTER_SECONDS} seconds'
      ORDER BY created_at ASC
      LIMIT ${RECENT_LIMIT}
    `;
    const res = await mark8lyQuery<MarketplaceRecentRow>("marketplace_api", sql);
    return res.rows.map((r) => ({
      database: "marketplace_api",
      id: r.id,
      kind: r.event_type,
      status: "pending" as const,
      attempts: null,
      ageSeconds: Number(r.age_seconds),
      lastError: r.error,
      tenantId: r.tenant_id,
      aggregate: r.aggregate,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export async function getOutboxOverview(): Promise<OutboxOverview> {
  // Parallel — both DB pools, both queries — so a slow side doesn't
  // serialize the whole page load.
  const [platformSummary, marketplaceSummary, platformRecent, marketplaceRecent] =
    await Promise.all([
      getPlatformSummary(),
      getMarketplaceSummary(),
      getPlatformRecentStuck(),
      getMarketplaceRecentStuck(),
    ]);

  const recent = [...platformRecent, ...marketplaceRecent].sort(
    (a, b) => b.ageSeconds - a.ageSeconds,
  );

  return {
    summaries: [platformSummary, marketplaceSummary],
    recent,
    generatedAt: new Date().toISOString(),
  };
}

export const OUTBOX_STUCK_AFTER_SECONDS = STUCK_AFTER_SECONDS;
