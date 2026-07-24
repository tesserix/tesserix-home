"use client";

import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";

interface OutboxRow {
  database: "platform_api" | "marketplace_api";
  id: string;
  kind: string;
  status: "pending" | "in_flight" | "completed" | "dead";
  attempts: number | null;
  ageSeconds: number;
  lastError: string | null;
  tenantId: string | null;
  aggregate: string | null;
  createdAt: string;
}

interface DatabaseSummary {
  database: "platform_api" | "marketplace_api";
  available: boolean;
  pending: number;
  inFlight: number;
  stuck: number;
  dead: number;
  oldestPendingAgeSeconds: number | null;
  errorMessage: string | null;
}

interface OverviewResponse {
  summaries: DatabaseSummary[];
  recent: OutboxRow[];
  generatedAt: string;
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700",
  in_flight: "bg-sky-50 text-sky-700",
  dead: "bg-rose-50 text-rose-700",
  completed: "bg-emerald-50 text-emerald-700",
};

const DB_TONE: Record<string, string> = {
  platform_api: "bg-violet-50 text-violet-700",
  marketplace_api: "bg-emerald-50 text-emerald-700",
};

export default function OutboxPage() {
  const { data, error, isLoading } = useSWR<OverviewResponse>(
    "/api/admin/outbox",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30_000 },
  );

  const summaries = data?.summaries ?? [];
  const recent = data?.recent ?? [];

  const totalPending = summaries.reduce((s, x) => s + x.pending, 0);
  const totalStuck = summaries.reduce((s, x) => s + x.stuck, 0);
  const totalDead = summaries.reduce((s, x) => s + x.dead, 0);
  const oldest = summaries.reduce<number | null>((o, x) => {
    if (x.oldestPendingAgeSeconds === null) return o;
    if (o === null) return x.oldestPendingAgeSeconds;
    return Math.max(o, x.oldestPendingAgeSeconds);
  }, null);

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Outbox events"
        description="Stuck rows in mark8ly's transactional outbox tables. Pending > 5 min counts as stuck."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile
            label="Pending"
            value={String(totalPending)}
            hint="awaiting drainer"
            loading={isLoading}
          />
          <KpiTile
            label="Stuck"
            value={String(totalStuck)}
            hint="pending > 5 min"
            loading={isLoading}
          />
          <KpiTile
            label="Dead"
            value={String(totalDead)}
            hint="exceeded retry budget"
            loading={isLoading}
          />
          <KpiTile
            label="Oldest pending"
            value={oldest === null ? "—" : formatAge(oldest)}
            hint="across both DBs"
            loading={isLoading}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {summaries.map((s) => (
            <DatabaseCard key={s.database} summary={s} />
          ))}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load outbox data.
          </div>
        )}

        {!isLoading && recent.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No stuck rows</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Drainers are keeping up. Anything pending has been outstanding for
              less than 5 minutes.
            </p>
          </div>
        )}

        {recent.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">DB</th>
                  <th className="px-4 py-3">Kind</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 tabular-nums">Attempts</th>
                  <th className="px-4 py-3">Age</th>
                  <th className="px-4 py-3">Tenant / aggregate</th>
                  <th className="px-4 py-3">Last error</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr
                    key={`${r.database}-${r.id}`}
                    className="border-b border-border last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${DB_TONE[r.database]}`}
                      >
                        {r.database === "platform_api" ? "platform" : "marketplace"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{r.kind}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[r.status] ?? "bg-muted"}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums">
                      {r.attempts ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums">
                      {formatAge(r.ageSeconds)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {r.tenantId ? (
                        <span className="block truncate font-mono" title={r.tenantId}>
                          {shortId(r.tenantId)}
                        </span>
                      ) : null}
                      {r.aggregate ? (
                        <span className="block text-muted-foreground">{r.aggregate}</span>
                      ) : null}
                      {!r.tenantId && !r.aggregate ? "—" : null}
                    </td>
                    <td
                      className="max-w-[24rem] px-4 py-3 text-xs text-muted-foreground"
                      title={r.lastError ?? undefined}
                    >
                      <span className="block truncate">{r.lastError ?? "—"}</span>
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

function DatabaseCard({ summary }: { summary: DatabaseSummary }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${DB_TONE[summary.database]}`}
        >
          {summary.database}
        </span>
        {summary.available ? (
          <span className="text-xs text-emerald-700">connected</span>
        ) : (
          <span className="text-xs text-rose-700" title={summary.errorMessage ?? undefined}>
            unavailable
          </span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
        <Stat label="Pending" value={summary.pending} />
        <Stat label="In flight" value={summary.inFlight} />
        <Stat label="Stuck" value={summary.stuck} tone={summary.stuck > 0 ? "warn" : undefined} />
        <Stat label="Dead" value={summary.dead} tone={summary.dead > 0 ? "danger" : undefined} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Oldest pending:{" "}
        <span className="tabular-nums">
          {summary.oldestPendingAgeSeconds === null
            ? "—"
            : formatAge(summary.oldestPendingAgeSeconds)}
        </span>
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
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
      <p className={`text-lg font-semibold tabular-nums ${colorClass}`}>{value}</p>
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

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}
