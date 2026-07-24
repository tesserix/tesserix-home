"use client";

// E4 — CNPG cluster health.
//
// Per-cluster snapshot for the CNPG fleet (tesserix-postgres + every
// per-product mark8ly / fanzone / homechef / etc cluster). Sourced
// from CNPG's Prometheus collector via /api/admin/cnpg-health.

import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";

type Status = "healthy" | "degraded" | "down";

interface Cluster {
  namespace: string;
  cluster: string;
  status: Status;
  collectorUp: boolean;
  instances: number;
  readyInstances: number;
  maxReplicationLagSeconds: number | null;
  connections: number | null;
  databaseSizeBytes: number | null;
  postmasterUptimeSeconds: number | null;
  lastAvailableBackupAt: string | null;
  lastFailedBackupAt: string | null;
}

interface OverviewResponse {
  clusters: Cluster[];
  totals: { clusters: number; healthy: number; degraded: number; down: number };
  available: boolean;
  errorMessage: string | null;
  generatedAt: string;
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const STATUS_TONE: Record<Status, string> = {
  healthy: "bg-emerald-50 text-emerald-700",
  degraded: "bg-amber-50 text-amber-700",
  down: "bg-rose-50 text-rose-700",
};

const STATUS_DOT: Record<Status, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-rose-500",
};

export default function DatabasesPage() {
  const { data, error, isLoading } = useSWR<OverviewResponse>(
    "/api/admin/cnpg-health",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30_000 },
  );

  const totals = data?.totals;
  const clusters = data?.clusters ?? [];

  // Use the server-side scrape time as the "now" reference rather than
  // Date.now() (which the react-hooks/purity rule disallows in render).
  // Backup-age then reads as "old the backup was at scrape" — fine, and
  // arguably more honest than "old at render time" since the underlying
  // data is itself a snapshot.
  const nowMs = data?.generatedAt
    ? new Date(data.generatedAt).getTime()
    : 0;

  // O2 — backup health roll-up. Two failure modes:
  //   1. recent failure: last_failed > last_available (last attempt blew up)
  //   2. stale: last_available > 24h ago (cron not firing or backups
  //      silently failing without emitting last_failed)
  const backupIssues = clusters.flatMap((c) => {
    const issues: { kind: "failed" | "stale" | "missing"; cluster: Cluster }[] = [];
    if (
      c.lastFailedBackupAt &&
      c.lastAvailableBackupAt &&
      new Date(c.lastFailedBackupAt) > new Date(c.lastAvailableBackupAt)
    ) {
      issues.push({ kind: "failed", cluster: c });
    } else if (!c.lastAvailableBackupAt) {
      issues.push({ kind: "missing", cluster: c });
    } else {
      const ageHours =
        (nowMs - new Date(c.lastAvailableBackupAt).getTime()) / 3_600_000;
      if (ageHours > 24) issues.push({ kind: "stale", cluster: c });
    }
    return issues;
  });

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Database clusters"
        description="CNPG cluster health — primary readiness, replicas, replication lag, connections, backups. Sourced from cnpg-collector via Prometheus, refreshed every 30s."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile
            label="Clusters"
            value={String(totals?.clusters ?? 0)}
            loading={isLoading}
          />
          <KpiTile
            label="Healthy"
            value={String(totals?.healthy ?? 0)}
            hint="primary up, no lag"
            loading={isLoading}
          />
          <KpiTile
            label="Degraded"
            value={String(totals?.degraded ?? 0)}
            hint="replica lag or partial"
            loading={isLoading}
          />
          <KpiTile
            label="Down"
            value={String(totals?.down ?? 0)}
            hint="primary not reachable"
            loading={isLoading}
          />
        </div>

        {backupIssues.length > 0 && (
          <div className="space-y-2 rounded-lg border border-amber-300/40 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">
              Backup attention needed on {backupIssues.length}{" "}
              cluster{backupIssues.length === 1 ? "" : "s"}
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {backupIssues.map(({ kind, cluster: c }) => (
                <li key={`${c.namespace}/${c.cluster}/${kind}`}>
                  <span className="font-mono">
                    {c.namespace}/{c.cluster}
                  </span>{" "}
                  —{" "}
                  {kind === "failed"
                    ? `last backup attempt failed (after a successful one at ${c.lastAvailableBackupAt})`
                    : kind === "missing"
                      ? "no successful backup ever recorded"
                      : `last successful backup is older than 24h (${c.lastAvailableBackupAt})`}
                </li>
              ))}
            </ul>
          </div>
        )}

        {data?.available === false && (
          <div className="rounded-lg border border-amber-300/40 bg-amber-50 p-4 text-sm text-amber-800">
            CNPG metrics unavailable
            {data.errorMessage ? ` — ${data.errorMessage}` : ""}.
          </div>
        )}
        {data?.available && data?.errorMessage && (
          <div className="rounded-lg border border-amber-300/40 bg-amber-50 p-4 text-sm text-amber-800">
            {data.errorMessage}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load database health.
          </div>
        )}

        {!isLoading && clusters.length === 0 && data?.available && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No CNPG clusters reporting.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Check that ServiceMonitor / PodMonitor is scraping cnpg-operator
              and the per-cluster pod sidecars.
            </p>
          </div>
        )}

        {clusters.length > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {clusters.map((c) => (
              <ClusterCard key={`${c.namespace}/${c.cluster}`} c={c} nowMs={nowMs} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ClusterCard({ c, nowMs }: { c: Cluster; nowMs: number }) {
  const lastBackupAge = c.lastAvailableBackupAt
    ? formatAge(
        Math.floor(
          (nowMs - new Date(c.lastAvailableBackupAt).getTime()) / 1000,
        ),
      )
    : null;
  const failedAfterSuccess =
    c.lastFailedBackupAt &&
    c.lastAvailableBackupAt &&
    new Date(c.lastFailedBackupAt) > new Date(c.lastAvailableBackupAt);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm">{c.cluster}</p>
          <p className="text-xs text-muted-foreground">{c.namespace}</p>
        </div>
        <span className="inline-flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.status]}`} aria-hidden="true" />
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[c.status]}`}
          >
            {c.status}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <Stat
          label="Instances"
          value={`${c.readyInstances} / ${c.instances || "?"}`}
          tone={
            c.instances === 0
              ? "danger"
              : c.readyInstances < c.instances
                ? "warn"
                : undefined
          }
        />
        <Stat
          label="Connections"
          value={c.connections === null ? "—" : String(c.connections)}
        />
        <Stat
          label="Replication lag"
          value={
            c.maxReplicationLagSeconds === null
              ? c.instances <= 1
                ? "n/a (single)"
                : "—"
              : `${c.maxReplicationLagSeconds.toFixed(1)}s`
          }
          tone={
            c.maxReplicationLagSeconds !== null && c.maxReplicationLagSeconds > 60
              ? "warn"
              : undefined
          }
        />
        <Stat
          label="Database size"
          value={
            c.databaseSizeBytes === null
              ? "—"
              : formatBytes(c.databaseSizeBytes)
          }
        />
        <Stat
          label="Uptime"
          value={
            c.postmasterUptimeSeconds === null
              ? "—"
              : formatAge(c.postmasterUptimeSeconds)
          }
        />
        <Stat
          label="Last backup"
          value={lastBackupAge ? `${lastBackupAge} ago` : "—"}
          tone={failedAfterSuccess ? "warn" : undefined}
        />
      </div>

      {failedAfterSuccess && (
        <p
          className="text-xs text-amber-700"
          title={`Failed: ${c.lastFailedBackupAt}\nLast OK: ${c.lastAvailableBackupAt}`}
        >
          ⚠ Last backup attempt failed (after the last successful one).
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | "danger";
}) {
  const colorClass =
    tone === "danger"
      ? "text-rose-700"
      : tone === "warn"
        ? "text-amber-700"
        : "text-foreground";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`text-sm tabular-nums ${colorClass}`}>{value}</p>
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
