// E3 — Service health snapshot.
//
// Workload-level health derived from kube-state-metrics via Prometheus.
// We surface per-workload (rather than per-pod) status so the page is
// scannable: a single row tells the operator "service X has Y/Z pods
// ready and Q restarts in the last 24h."
//
// Knative scale-to-zero is honored — a workload sitting at 0/0 is idle
// (which is the design intent for scale-to-zero services), not broken.
// The page distinguishes idle / healthy / degraded / down via the
// derived `status` field.

import { queryInstant } from "./prometheus";

export type WorkloadStatus = "healthy" | "degraded" | "down" | "idle";

export interface WorkloadHealth {
  readonly namespace: string;
  readonly workload: string;
  readonly readyPods: number;
  readonly totalPods: number;
  readonly restarts24h: number;
  readonly totalRestarts: number;
  readonly status: WorkloadStatus;
}

export interface ServiceHealthOverview {
  readonly workloads: ReadonlyArray<WorkloadHealth>;
  readonly totals: {
    readonly workloads: number;
    readonly healthy: number;
    readonly degraded: number;
    readonly down: number;
    readonly idle: number;
    readonly restarts24h: number;
  };
  readonly available: boolean;
  readonly errorMessage: string | null;
  readonly generatedAt: string;
}

const NAMESPACE_FILTER = "tesserix|platform|shared|marketplace|knative-serving|istio-system";

// kube-state-metrics exposes the Knative service name on the
// `label_serving_knative_dev_service` label. We try that first; if it's
// missing, fall back to `label_app_kubernetes_io_name` (Helm/Kustomize
// standard) and lastly `label_app`. As a last resort we use the pod
// prefix (everything before the last replica-set hash).
function pickWorkloadName(labels: Readonly<Record<string, string>>): string {
  return (
    labels.label_serving_knative_dev_service ||
    labels.label_app_kubernetes_io_name ||
    labels.label_app ||
    stripPodHash(labels.pod) ||
    "unknown"
  );
}

function stripPodHash(pod: string | undefined): string {
  if (!pod) return "";
  // ReplicaSet pods: <name>-<rs-hash>-<pod-hash>. Strip the trailing two
  // segments of dash-separated hashes (when they look hash-like).
  const parts = pod.split("-");
  if (parts.length >= 3 && /^[a-z0-9]{4,12}$/.test(parts[parts.length - 1])) {
    parts.pop();
    if (/^[a-z0-9]{5,11}$/.test(parts[parts.length - 1])) parts.pop();
  }
  return parts.join("-");
}

function statusFor(ready: number, total: number): WorkloadStatus {
  if (total === 0) return "idle";
  if (ready === 0) return "down";
  if (ready < total) return "degraded";
  return "healthy";
}

interface PodRow {
  namespace: string;
  pod: string;
  workload: string;
  ready: boolean;
  restartsTotal: number;
  restarts24h: number;
}

export async function getServiceHealthOverview(): Promise<ServiceHealthOverview> {
  try {
    // 1) kube_pod_labels gives us the pod→workload mapping (with helm /
    //    knative labels). 2) kube_pod_status_ready isolates ready pods.
    //    3) kube_pod_container_status_restarts_total cumulative; 4) the
    //    `increase` form for the 24h window.
    const [labelInfo, readyInfo, restartsTotal, restarts24h] = await Promise.all([
      queryInstant(`kube_pod_labels{namespace=~"${NAMESPACE_FILTER}"}`),
      queryInstant(
        `kube_pod_status_ready{condition="true",namespace=~"${NAMESPACE_FILTER}"} == 1`,
      ),
      queryInstant(
        `sum by (namespace, pod) (kube_pod_container_status_restarts_total{namespace=~"${NAMESPACE_FILTER}"})`,
      ),
      queryInstant(
        `sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{namespace=~"${NAMESPACE_FILTER}"}[24h]))`,
      ),
    ]);

    const readySet = new Set(
      readyInfo.map((r) => `${r.metric.namespace}/${r.metric.pod}`),
    );
    const restartsTotalMap = new Map(
      restartsTotal.map((r) => [
        `${r.metric.namespace}/${r.metric.pod}`,
        Math.round(r.value.value),
      ]),
    );
    const restarts24hMap = new Map(
      restarts24h.map((r) => [
        `${r.metric.namespace}/${r.metric.pod}`,
        Math.max(0, Math.round(r.value.value)),
      ]),
    );

    const podRows: PodRow[] = labelInfo.map((row) => {
      const ns = row.metric.namespace ?? "";
      const pod = row.metric.pod ?? "";
      const key = `${ns}/${pod}`;
      return {
        namespace: ns,
        pod,
        workload: pickWorkloadName({ ...row.metric, namespace: ns, pod }),
        ready: readySet.has(key),
        restartsTotal: restartsTotalMap.get(key) ?? 0,
        restarts24h: restarts24hMap.get(key) ?? 0,
      };
    });

    // Aggregate by (namespace, workload).
    const byWorkload = new Map<string, WorkloadHealth>();
    for (const p of podRows) {
      const key = `${p.namespace}/${p.workload}`;
      const prev = byWorkload.get(key);
      const next: WorkloadHealth = prev
        ? {
            ...prev,
            totalPods: prev.totalPods + 1,
            readyPods: prev.readyPods + (p.ready ? 1 : 0),
            restarts24h: prev.restarts24h + p.restarts24h,
            totalRestarts: prev.totalRestarts + p.restartsTotal,
            status: statusFor(
              prev.readyPods + (p.ready ? 1 : 0),
              prev.totalPods + 1,
            ),
          }
        : {
            namespace: p.namespace,
            workload: p.workload,
            totalPods: 1,
            readyPods: p.ready ? 1 : 0,
            restarts24h: p.restarts24h,
            totalRestarts: p.restartsTotal,
            status: statusFor(p.ready ? 1 : 0, 1),
          };
      byWorkload.set(key, next);
    }

    const workloads = Array.from(byWorkload.values()).sort((a, b) => {
      // Down first, then degraded, then by 24h restarts desc, then name.
      const rank: Record<WorkloadStatus, number> = {
        down: 0,
        degraded: 1,
        healthy: 2,
        idle: 3,
      };
      const r = rank[a.status] - rank[b.status];
      if (r !== 0) return r;
      const restarts = b.restarts24h - a.restarts24h;
      if (restarts !== 0) return restarts;
      return a.workload.localeCompare(b.workload);
    });

    const totals = workloads.reduce(
      (acc, w) => ({
        workloads: acc.workloads + 1,
        healthy: acc.healthy + (w.status === "healthy" ? 1 : 0),
        degraded: acc.degraded + (w.status === "degraded" ? 1 : 0),
        down: acc.down + (w.status === "down" ? 1 : 0),
        idle: acc.idle + (w.status === "idle" ? 1 : 0),
        restarts24h: acc.restarts24h + w.restarts24h,
      }),
      { workloads: 0, healthy: 0, degraded: 0, down: 0, idle: 0, restarts24h: 0 },
    );

    return {
      workloads,
      totals,
      available: true,
      errorMessage: null,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      workloads: [],
      totals: {
        workloads: 0,
        healthy: 0,
        degraded: 0,
        down: 0,
        idle: 0,
        restarts24h: 0,
      },
      available: false,
      errorMessage: err instanceof Error ? err.message : "unknown_error",
      generatedAt: new Date().toISOString(),
    };
  }
}
