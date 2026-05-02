"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";

type WorkloadStatus = "healthy" | "degraded" | "down" | "idle";

interface WorkloadHealth {
  namespace: string;
  workload: string;
  readyPods: number;
  totalPods: number;
  restarts24h: number;
  totalRestarts: number;
  status: WorkloadStatus;
}

interface OverviewResponse {
  workloads: WorkloadHealth[];
  totals: {
    workloads: number;
    healthy: number;
    degraded: number;
    down: number;
    idle: number;
    restarts24h: number;
  };
  available: boolean;
  errorMessage: string | null;
  generatedAt: string;
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const STATUS_TONE: Record<WorkloadStatus, string> = {
  healthy: "bg-emerald-50 text-emerald-700",
  degraded: "bg-amber-50 text-amber-700",
  down: "bg-rose-50 text-rose-700",
  idle: "bg-muted text-muted-foreground",
};

const STATUS_DOT: Record<WorkloadStatus, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-rose-500",
  idle: "bg-muted-foreground/40",
};

export default function ServiceHealthPage() {
  const { data, error, isLoading } = useSWR<OverviewResponse>(
    "/api/admin/service-health",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30_000 },
  );

  const [namespaceFilter, setNamespaceFilter] = useState<string>("");
  const [hideIdle, setHideIdle] = useState(false);

  const workloads = data?.workloads ?? [];
  const totals = data?.totals;

  const namespaces = useMemo(() => {
    const set = new Set(workloads.map((w) => w.namespace));
    return Array.from(set).sort();
  }, [workloads]);

  const filtered = useMemo(
    () =>
      workloads.filter((w) => {
        if (namespaceFilter && w.namespace !== namespaceFilter) return false;
        if (hideIdle && w.status === "idle") return false;
        return true;
      }),
    [workloads, namespaceFilter, hideIdle],
  );

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Service health"
        description="Per-workload pod readiness and restart counts. Sourced from kube-state-metrics via Prometheus, refreshed every 30s."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <KpiTile
            label="Workloads"
            value={String(totals?.workloads ?? 0)}
            hint="across tracked namespaces"
            loading={isLoading}
          />
          <KpiTile
            label="Healthy"
            value={String(totals?.healthy ?? 0)}
            hint="all pods ready"
            loading={isLoading}
          />
          <KpiTile
            label="Degraded"
            value={String(totals?.degraded ?? 0)}
            hint="some pods not ready"
            loading={isLoading}
          />
          <KpiTile
            label="Down"
            value={String(totals?.down ?? 0)}
            hint="zero ready pods"
            loading={isLoading}
          />
          <KpiTile
            label="Restarts 24h"
            value={String(totals?.restarts24h ?? 0)}
            hint="across all workloads"
            loading={isLoading}
          />
        </div>

        {data?.available === false && (
          <div className="rounded-lg border border-amber-300/40 bg-amber-50 p-4 text-sm text-amber-800">
            Prometheus is unreachable
            {data.errorMessage ? ` — ${data.errorMessage}` : ""}.
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load service health.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-1.5">
          <button
            onClick={() => setNamespaceFilter("")}
            aria-pressed={namespaceFilter === ""}
            className={
              "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
              (namespaceFilter === ""
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50")
            }
          >
            All namespaces
          </button>
          {namespaces.map((ns) => (
            <button
              key={ns}
              onClick={() => setNamespaceFilter(ns)}
              aria-pressed={namespaceFilter === ns}
              className={
                "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
                (namespaceFilter === ns
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50")
              }
            >
              {ns}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50">
            <input
              type="checkbox"
              checked={hideIdle}
              onChange={(e) => setHideIdle(e.target.checked)}
              className="h-3 w-3"
            />
            Hide idle (scale-to-zero)
          </label>
        </div>

        {!isLoading && filtered.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No workloads match the current filter.</p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Namespace</th>
                  <th className="px-4 py-3">Workload</th>
                  <th className="px-4 py-3 tabular-nums">Pods</th>
                  <th className="px-4 py-3 tabular-nums">Restarts (24h)</th>
                  <th className="px-4 py-3 tabular-nums">Restarts (total)</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((w) => (
                  <tr
                    key={`${w.namespace}/${w.workload}`}
                    className="border-b border-border last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${STATUS_DOT[w.status]}`}
                          aria-hidden="true"
                        />
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[w.status]}`}
                        >
                          {w.status}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {w.namespace}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{w.workload}</td>
                    <td className="px-4 py-3 text-xs tabular-nums">
                      <PodCount ready={w.readyPods} total={w.totalPods} />
                    </td>
                    <td
                      className={
                        "px-4 py-3 text-xs tabular-nums " +
                        (w.restarts24h > 0 ? "font-medium text-amber-700" : "")
                      }
                    >
                      {w.restarts24h}
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
                      {w.totalRestarts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PodCount({ ready, total }: { ready: number; total: number }) {
  if (total === 0) {
    return <span className="text-muted-foreground">0 / 0</span>;
  }
  const tone =
    ready === total
      ? "text-emerald-700"
      : ready === 0
        ? "text-rose-700"
        : "text-amber-700";
  return (
    <span className={tone}>
      {ready} / {total}
    </span>
  );
}
