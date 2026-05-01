// Product-level metrics aggregator: composes Prometheus + OpenCost +
// notification-service email events into a single shape consumed by the
// /admin/apps/[product] overview page.
//
// All upstreams are queried in parallel. Each section has its own try
// boundary so a single upstream failure (Prom flapping, OpenCost not yet
// whitelisted) degrades that section to nulls without taking down the
// whole response.

import { queryInstant, queryRange } from "./prometheus";
import { getNamespaceCost, type CostWindow } from "./opencost";
import { getEmailMetrics } from "./email-events";
import { SPARKLINE_STEP_SECONDS, WINDOW_SECONDS, type SparklinePoint, type Window } from "./window";
import type { ProductConfig } from "@/lib/products/types";
import { logger } from "@/lib/logger";

export interface ResourceMetrics {
  readonly cpu: { current: number; sparkline: ReadonlyArray<SparklinePoint> } | null;
  readonly memory: { current: number; sparkline: ReadonlyArray<SparklinePoint> } | null;
  readonly pods: { count: number } | null;
  readonly db: {
    readonly sizeBytes: number;
    readonly replicationLagSeconds: number;
    readonly activeConnections: number;
  } | null;
}

export interface CostMetrics {
  readonly currency: string;
  readonly total: number;
  readonly breakdown: {
    readonly cpu: number;
    readonly ram: number;
    readonly pv: number;
    readonly network: number;
    readonly loadBalancer: number;
  };
}

export interface ProductMetrics {
  readonly product: { id: string; name: string };
  readonly window: Window;
  readonly generatedAt: string;
  readonly resources: ResourceMetrics;
  readonly cost: CostMetrics | null;
  readonly email: Awaited<ReturnType<typeof getEmailMetrics>>;
}

function singleScalar(result: { value: { value: number } } | undefined): number {
  return result?.value.value ?? 0;
}

function sparkFrom(matrix: ReadonlyArray<{ values: ReadonlyArray<{ time: number; value: number }> }>): ReadonlyArray<SparklinePoint> {
  const series = matrix[0]?.values ?? [];
  return series.map((p) => ({ t: p.time, v: p.value }));
}

async function fetchResources(config: ProductConfig, window: Window): Promise<ResourceMetrics> {
  const ns = config.namespace;
  const cluster = config.cnpgClusterName;
  const now = Math.floor(Date.now() / 1000);
  const start = now - WINDOW_SECONDS[window];
  const step = SPARKLINE_STEP_SECONDS[window];

  const cpuQ = `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}"}[5m]))`;
  const memQ = `sum(container_memory_working_set_bytes{namespace="${ns}"})`;
  const podQ = `count(kube_pod_status_phase{namespace="${ns}",phase="Running"} == 1)`;
  const dbSizeQ = `sum(cnpg_pg_database_size_bytes{cluster="${cluster}"})`;
  const dbLagQ = `max(cnpg_pg_replication_lag{cluster="${cluster}"})`;
  const dbConnQ = `sum(cnpg_collector_pg_stat_activity{cluster="${cluster}",state="active"})`;

  const [cpuNow, memNow, podNow, dbSize, dbLag, dbConn, cpuRange, memRange] = await Promise.allSettled([
    queryInstant(cpuQ),
    queryInstant(memQ),
    queryInstant(podQ),
    queryInstant(dbSizeQ),
    queryInstant(dbLagQ),
    queryInstant(dbConnQ),
    queryRange(cpuQ, start, now, step),
    queryRange(memQ, start, now, step),
  ]);

  const value = (r: PromiseSettledResult<Awaited<ReturnType<typeof queryInstant>>>): number =>
    r.status === "fulfilled" ? singleScalar(r.value[0]) : 0;
  const series = (r: PromiseSettledResult<Awaited<ReturnType<typeof queryRange>>>) =>
    r.status === "fulfilled" ? sparkFrom(r.value) : [];

  return {
    cpu: { current: value(cpuNow), sparkline: series(cpuRange) },
    memory: { current: value(memNow), sparkline: series(memRange) },
    pods: { count: Math.round(value(podNow)) },
    db: {
      sizeBytes: value(dbSize),
      replicationLagSeconds: value(dbLag),
      activeConnections: Math.round(value(dbConn)),
    },
  };
}

async function fetchCost(config: ProductConfig, window: Window): Promise<CostMetrics | null> {
  try {
    const ns = await getNamespaceCost(config.namespace, window as CostWindow);
    return {
      currency: ns.currency,
      total: ns.total,
      breakdown: {
        cpu: ns.cpu,
        ram: ns.ram,
        pv: ns.pv,
        network: ns.network,
        loadBalancer: ns.loadBalancer,
      },
    };
  } catch (err) {
    logger.warn("product-metrics: opencost unavailable", err);
    return null;
  }
}

export async function getProductMetrics(config: ProductConfig, window: Window): Promise<ProductMetrics> {
  const [resources, cost, email] = await Promise.all([
    fetchResources(config, window),
    fetchCost(config, window),
    getEmailMetrics({ product: config.sendGridProductTag, days: 30 }),
  ]);

  return {
    product: { id: config.id, name: config.name },
    window,
    generatedAt: new Date().toISOString(),
    resources,
    cost,
    email,
  };
}
