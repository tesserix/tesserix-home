// Tenant-level metrics aggregator: cross-DB row counts + storage estimate +
// Istio request/bandwidth slices + cost-share + email events. Same
// graceful-degradation pattern as product-metrics: each section
// independent, individual upstream failures don't fail the whole route.
//
// Istio metrics depend on mark8ly emitting `tenant_id` label (Wave 5).
// Until that lands, request/bandwidth fields are 0 — the dashboard renders
// dashes per the UX spec.

import { queryInstant, queryRange } from "./prometheus";
import { getEmailMetrics } from "./email-events";
import { computeTenantCostShare, type TenantCostShare } from "./cost-proxy";
import { getTenantRowCounts, getTenantStorageEstimate } from "@/lib/db/mark8ly-tenant-metrics";
import { SPARKLINE_STEP_SECONDS, WINDOW_SECONDS, type SparklinePoint, type Window } from "./window";
import type { ProductConfig } from "@/lib/products/types";
import { logger } from "@/lib/logger";

export interface TenantActivity {
  readonly storageBytes: number;
  readonly storagePerTable: Readonly<Record<string, number>>;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly requestRate: { current: number; sparkline: ReadonlyArray<SparklinePoint> } | null;
  readonly bandwidth: {
    readonly inSparkline: ReadonlyArray<SparklinePoint>;
    readonly outSparkline: ReadonlyArray<SparklinePoint>;
  } | null;
}

export interface TenantMetrics {
  readonly tenant: { id: string };
  readonly window: Window;
  readonly generatedAt: string;
  readonly activity: TenantActivity;
  readonly cost: TenantCostShare | null;
  readonly email: Awaited<ReturnType<typeof getEmailMetrics>>;
}

function rangeFrom(matrix: ReadonlyArray<{ values: ReadonlyArray<{ time: number; value: number }> }>): ReadonlyArray<SparklinePoint> {
  const series = matrix[0]?.values ?? [];
  return series.map((p) => ({ t: p.time, v: p.value }));
}

async function fetchActivity(config: ProductConfig, tenantId: string, window: Window): Promise<TenantActivity> {
  const ns = config.namespace;
  const now = Math.floor(Date.now() / 1000);
  const start = now - WINDOW_SECONDS[window];
  const step = SPARKLINE_STEP_SECONDS[window];

  const reqQ = `sum(rate(istio_requests_total{destination_workload_namespace="${ns}",tenant_id="${tenantId}"}[5m]))`;
  const inQ = `sum(rate(istio_request_bytes_sum{destination_workload_namespace="${ns}",tenant_id="${tenantId}"}[5m]))`;
  const outQ = `sum(rate(istio_response_bytes_sum{destination_workload_namespace="${ns}",tenant_id="${tenantId}"}[5m]))`;

  const [storage, rows, reqNow, reqRange, inRange, outRange] = await Promise.allSettled([
    getTenantStorageEstimate(tenantId, config.rowCountTables),
    getTenantRowCounts(tenantId, config.rowCountTables),
    queryInstant(reqQ),
    queryRange(reqQ, start, now, step),
    queryRange(inQ, start, now, step),
    queryRange(outQ, start, now, step),
  ]);

  const storageVal = storage.status === "fulfilled" ? storage.value : { bytes: 0, perTable: {} };
  const rowsVal = rows.status === "fulfilled" ? rows.value : { counts: {}, total: 0 };

  const reqCurrent = reqNow.status === "fulfilled" ? reqNow.value[0]?.value.value ?? 0 : 0;
  const reqSeries = reqRange.status === "fulfilled" ? rangeFrom(reqRange.value) : [];
  const inSeries = inRange.status === "fulfilled" ? rangeFrom(inRange.value) : [];
  const outSeries = outRange.status === "fulfilled" ? rangeFrom(outRange.value) : [];

  return {
    storageBytes: storageVal.bytes,
    storagePerTable: storageVal.perTable,
    rowCounts: rowsVal.counts,
    requestRate: { current: reqCurrent, sparkline: reqSeries },
    bandwidth: { inSparkline: inSeries, outSparkline: outSeries },
  };
}

async function fetchCost(config: ProductConfig, tenantId: string, window: Window): Promise<TenantCostShare | null> {
  try {
    return await computeTenantCostShare(config, tenantId, window);
  } catch (err) {
    logger.warn("tenant-metrics: cost-proxy unavailable", err);
    return null;
  }
}

export async function getTenantMetrics(config: ProductConfig, tenantId: string, window: Window): Promise<TenantMetrics> {
  const [activity, cost, email] = await Promise.all([
    fetchActivity(config, tenantId, window),
    fetchCost(config, tenantId, window),
    getEmailMetrics({ product: config.sendGridProductTag, tenantId, days: 30 }),
  ]);

  return {
    tenant: { id: tenantId },
    window,
    generatedAt: new Date().toISOString(),
    activity,
    cost,
    email,
  };
}
