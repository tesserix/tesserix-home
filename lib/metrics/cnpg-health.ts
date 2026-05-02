// E4 — CNPG cluster health.
//
// Per-cluster snapshot derived from the metrics CNPG's per-pod collector
// emits. Cluster discovery is metric-driven (we ask Prometheus what
// clusters it sees) so adding a new CNPG cluster doesn't require a
// config change here — the dashboard picks it up on the next scrape.
//
// Status logic (intentionally lenient for single-instance clusters,
// which is how every CNPG cluster in this fleet is currently sized):
//   - down       : `cnpg_collector_up` < 1, OR no postmaster start time
//   - degraded   : any replica `cnpg_pg_replication_lag` > 60s
//   - healthy    : everything else
//
// Backup health is intentionally NOT here — that's a separate page
// (O2) so cluster operators can drill into backup state independently.
// We surface only the most recent successful backup time as a hint.
//
// Resilience: each metric query is wrapped in safeQuery so a missing
// metric (e.g. CNPG version that doesn't expose `cnpg_pg_database_size_bytes`)
// doesn't crash the page. We surface what we can find.

import { queryInstant, type PromInstantResult } from "./prometheus";
import { logger } from "@/lib/logger";

export type CNPGStatus = "healthy" | "degraded" | "down";

export interface CNPGCluster {
  readonly namespace: string;
  readonly cluster: string;
  readonly status: CNPGStatus;
  readonly collectorUp: boolean;
  readonly instances: number;
  readonly readyInstances: number;
  readonly maxReplicationLagSeconds: number | null;
  readonly connections: number | null;
  readonly databaseSizeBytes: number | null;
  readonly postmasterUptimeSeconds: number | null;
  readonly lastAvailableBackupAt: string | null;
  readonly lastFailedBackupAt: string | null;
}

export interface CNPGHealthOverview {
  readonly clusters: ReadonlyArray<CNPGCluster>;
  readonly totals: {
    readonly clusters: number;
    readonly healthy: number;
    readonly degraded: number;
    readonly down: number;
  };
  readonly available: boolean;
  readonly errorMessage: string | null;
  readonly generatedAt: string;
}

async function safeQuery(promql: string): Promise<ReadonlyArray<PromInstantResult>> {
  try {
    return await queryInstant(promql);
  } catch (err) {
    logger.warn("[cnpg-health] metric query failed; degrading", {
      promql,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

interface PerPodMetric<T = number> {
  readonly namespace: string;
  readonly cluster: string;
  readonly pod: string;
  readonly value: T;
}

function readPerPod(rows: ReadonlyArray<PromInstantResult>): PerPodMetric[] {
  return rows
    .map((r) => {
      const ns = r.metric.namespace ?? "";
      const cluster = r.metric.cluster ?? r.metric.cnpg_cluster ?? "";
      const pod = r.metric.pod ?? "";
      if (!ns || !cluster) return null;
      return { namespace: ns, cluster, pod, value: r.value.value };
    })
    .filter((x): x is PerPodMetric => x !== null);
}

function clusterKey(namespace: string, cluster: string): string {
  return `${namespace}/${cluster}`;
}

function statusFor(
  collectorUp: boolean,
  postmasterUp: boolean,
  maxLag: number | null,
): CNPGStatus {
  if (!collectorUp || !postmasterUp) return "down";
  if (maxLag !== null && maxLag > 60) return "degraded";
  return "healthy";
}

function unixTimeToISO(unixSeconds: number): string | null {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

export async function getCNPGClusterHealth(): Promise<CNPGHealthOverview> {
  try {
    // Discovery + parallel fetches. Any single missing metric returns
    // an empty array; downstream maps treat empty as null/unknown.
    const [
      collectorUp,
      replicationLag,
      backendsTotal,
      databaseSize,
      postmasterStart,
      lastAvailableBackup,
      lastFailedBackup,
    ] = await Promise.all([
      safeQuery(`cnpg_collector_up`),
      safeQuery(`cnpg_pg_replication_lag`),
      safeQuery(`sum by (namespace, cluster, pod) (cnpg_backends_total)`),
      safeQuery(
        `sum by (namespace, cluster, pod) (cnpg_pg_database_size_bytes{datname!~"template.*|postgres"})`,
      ),
      safeQuery(`cnpg_pg_postmaster_start_time_seconds`),
      safeQuery(`cnpg_collector_last_available_backup_timestamp`),
      safeQuery(`cnpg_collector_last_failed_backup_timestamp`),
    ]);

    // Discover clusters: anything that exposes collector_up OR postmaster.
    const clusters = new Map<string, { namespace: string; cluster: string }>();
    for (const r of [...collectorUp, ...postmasterStart, ...backendsTotal]) {
      const ns = r.metric.namespace ?? "";
      const c = r.metric.cluster ?? r.metric.cnpg_cluster ?? "";
      if (ns && c) clusters.set(clusterKey(ns, c), { namespace: ns, cluster: c });
    }

    if (clusters.size === 0) {
      // No CNPG metrics at all. Either the operator metrics aren't being
      // scraped or there are no clusters in the fleet (unlikely). Surface
      // as "available but empty" with a hint in errorMessage so the page
      // can render a meaningful empty state.
      return {
        clusters: [],
        totals: { clusters: 0, healthy: 0, degraded: 0, down: 0 },
        available: true,
        errorMessage:
          "No CNPG clusters reporting metrics. Check that ServiceMonitor / PodMonitor is scraping cnpg-operator and cnpg cluster pods.",
        generatedAt: new Date().toISOString(),
      };
    }

    const lagByCluster = new Map<string, number>();
    for (const m of readPerPod(replicationLag)) {
      const key = clusterKey(m.namespace, m.cluster);
      const prev = lagByCluster.get(key) ?? -Infinity;
      if (m.value > prev) lagByCluster.set(key, m.value);
    }

    // Aggregate per-pod metrics → per-cluster.
    const aggregateByCluster = (
      pods: ReadonlyArray<PerPodMetric>,
      reducer: "sum" | "max",
    ): Map<string, number> => {
      const out = new Map<string, number>();
      for (const p of pods) {
        const key = clusterKey(p.namespace, p.cluster);
        const prev = out.get(key);
        if (prev === undefined) {
          out.set(key, p.value);
        } else if (reducer === "sum") {
          out.set(key, prev + p.value);
        } else {
          out.set(key, Math.max(prev, p.value));
        }
      }
      return out;
    };

    const connByCluster = aggregateByCluster(readPerPod(backendsTotal), "sum");
    const sizeByCluster = aggregateByCluster(readPerPod(databaseSize), "sum");

    const upByCluster = new Map<string, boolean>();
    for (const r of collectorUp) {
      const ns = r.metric.namespace ?? "";
      const c = r.metric.cluster ?? r.metric.cnpg_cluster ?? "";
      if (!ns || !c) continue;
      upByCluster.set(clusterKey(ns, c), r.value.value >= 1);
    }

    // Instance counts per cluster: total = number of postmaster_start rows
    // (one per running pod), ready = subset where collector_up == 1.
    const instancesByCluster = new Map<string, { total: number; ready: number }>();
    for (const r of postmasterStart) {
      const ns = r.metric.namespace ?? "";
      const c = r.metric.cluster ?? r.metric.cnpg_cluster ?? "";
      if (!ns || !c) continue;
      const key = clusterKey(ns, c);
      const prev = instancesByCluster.get(key) ?? { total: 0, ready: 0 };
      instancesByCluster.set(key, {
        total: prev.total + 1,
        ready: prev.ready + (r.value.value > 0 ? 1 : 0),
      });
    }

    const earliestPostmaster = new Map<string, number>();
    for (const r of postmasterStart) {
      const ns = r.metric.namespace ?? "";
      const c = r.metric.cluster ?? r.metric.cnpg_cluster ?? "";
      if (!ns || !c) continue;
      const key = clusterKey(ns, c);
      const ts = r.value.value;
      const prev = earliestPostmaster.get(key);
      if (ts > 0 && (prev === undefined || ts < prev)) {
        earliestPostmaster.set(key, ts);
      }
    }

    const lastBackupBy = (rows: ReadonlyArray<PromInstantResult>): Map<string, number> => {
      const out = new Map<string, number>();
      for (const r of rows) {
        const ns = r.metric.namespace ?? "";
        const c = r.metric.cluster ?? r.metric.cnpg_cluster ?? "";
        if (!ns || !c) continue;
        const key = clusterKey(ns, c);
        const ts = r.value.value;
        const prev = out.get(key);
        if (ts > 0 && (prev === undefined || ts > prev)) out.set(key, ts);
      }
      return out;
    };
    const availableBackupAt = lastBackupBy(lastAvailableBackup);
    const failedBackupAt = lastBackupBy(lastFailedBackup);

    const nowSec = Math.floor(Date.now() / 1000);
    const result: CNPGCluster[] = Array.from(clusters.values()).map(
      ({ namespace, cluster }) => {
        const key = clusterKey(namespace, cluster);
        const lag = lagByCluster.get(key) ?? null;
        const collector = upByCluster.get(key) ?? false;
        const inst = instancesByCluster.get(key) ?? { total: 0, ready: 0 };
        const start = earliestPostmaster.get(key);
        const uptime = start ? Math.max(0, nowSec - start) : null;

        return {
          namespace,
          cluster,
          collectorUp: collector,
          instances: inst.total,
          readyInstances: inst.ready,
          maxReplicationLagSeconds: lag,
          connections: connByCluster.get(key) ?? null,
          databaseSizeBytes: sizeByCluster.get(key) ?? null,
          postmasterUptimeSeconds: uptime,
          lastAvailableBackupAt: unixTimeToISO(availableBackupAt.get(key) ?? 0),
          lastFailedBackupAt: unixTimeToISO(failedBackupAt.get(key) ?? 0),
          status: statusFor(collector, inst.ready > 0, lag),
        };
      },
    );

    result.sort((a, b) => {
      const rank: Record<CNPGStatus, number> = { down: 0, degraded: 1, healthy: 2 };
      const r = rank[a.status] - rank[b.status];
      if (r !== 0) return r;
      return a.cluster.localeCompare(b.cluster);
    });

    const totals = result.reduce(
      (acc, c) => ({
        clusters: acc.clusters + 1,
        healthy: acc.healthy + (c.status === "healthy" ? 1 : 0),
        degraded: acc.degraded + (c.status === "degraded" ? 1 : 0),
        down: acc.down + (c.status === "down" ? 1 : 0),
      }),
      { clusters: 0, healthy: 0, degraded: 0, down: 0 },
    );

    return {
      clusters: result,
      totals,
      available: true,
      errorMessage: null,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      clusters: [],
      totals: { clusters: 0, healthy: 0, degraded: 0, down: 0 },
      available: false,
      errorMessage: err instanceof Error ? err.message : "unknown_error",
      generatedAt: new Date().toISOString(),
    };
  }
}
