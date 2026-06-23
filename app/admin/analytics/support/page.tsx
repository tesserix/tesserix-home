"use client";

import useSWR from "swr";

const REFRESH = 30_000; // live-ish: re-pull every 30s

// PlatformSupportStats mirrors otto's PlatformStats JSON
// (/api/v1/platform/otto/stats) — a cross-tenant rollup of support chats.
interface PlatformSupportStats {
  total: number;
  open: number;
  by_status: Record<string, number>;
  by_reason: Record<string, number>;
  by_tenant: Record<string, number>;
  escalated: number;
  ai_resolved: number;
  avg_resolution_seconds: number;
  csat: number;
  resolved_rate: number;
  feedback_count: number;
}

const fetcher = (url: string) =>
  fetch(url, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`load failed (${r.status})`);
    return r.json() as Promise<PlatformSupportStats>;
  });

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function Bars({
  title,
  data,
  empty,
}: {
  title: string;
  data: [string, number][];
  empty: string;
}) {
  const max = data.reduce((m, [, v]) => Math.max(m, v), 0) || 1;
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
        {title}
      </h2>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-3 rounded-lg border border-border p-4">
          {data.map(([label, count]) => (
            <div key={label}>
              <div className="mb-1 flex justify-between text-sm">
                <span className="truncate text-foreground" title={label}>
                  {label}
                </span>
                <span className="ml-2 shrink-0 font-medium text-foreground tabular-nums">
                  {count.toLocaleString()}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-foreground"
                  style={{ width: `${Math.max(4, (count / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number | undefined): string {
  const s = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
  if (s <= 0) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function rate(n: number, d: number): string {
  if (!d) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}

function sortedEntries(rec: Record<string, number> | undefined): [string, number][] {
  return Object.entries(rec ?? {}).sort((a, b) => b[1] - a[1]);
}

export default function PlatformSupportAnalyticsPage() {
  const { data, error, isLoading, isValidating } = useSWR<PlatformSupportStats>(
    "/api/admin/analytics/support",
    fetcher,
    { refreshInterval: REFRESH },
  );

  const d = data;
  const loading = isLoading && !d;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            Support analytics
          </h1>
          <p className="text-sm text-muted-foreground">
            Otto support chat across all tenants · live (30s refresh)
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
          {isValidating ? "updating…" : "live"}
        </span>
      </div>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t load support analytics: {(error as Error).message}
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {/* Volume */}
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
              Volume
            </h2>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Tile label="Total conversations" value={(d?.total ?? 0).toLocaleString()} />
              <Tile
                label="Open"
                value={(d?.open ?? 0).toLocaleString()}
                sub="pending + active"
              />
              <Tile
                label="AI-resolved"
                value={(d?.ai_resolved ?? 0).toLocaleString()}
                sub={`${rate(d?.ai_resolved ?? 0, d?.total ?? 0)} of all`}
              />
              <Tile
                label="Escalated to human"
                value={(d?.escalated ?? 0).toLocaleString()}
                sub={`${rate(d?.escalated ?? 0, d?.total ?? 0)} of all`}
              />
            </div>
          </div>

          {/* Quality & efficiency */}
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
              Quality & efficiency
            </h2>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Tile
                label="Avg resolution time"
                value={formatDuration(d?.avg_resolution_seconds)}
                sub="created → closed"
              />
              <Tile
                label="CSAT"
                value={d?.csat ? `${d.csat.toFixed(1)} / 5` : "—"}
                sub="post-case rating"
              />
              <Tile
                label="Resolved rate"
                value={d?.feedback_count ? `${Math.round((d.resolved_rate ?? 0) * 100)}%` : "—"}
                sub="customer-reported"
              />
              <Tile
                label="Feedback responses"
                value={(d?.feedback_count ?? 0).toLocaleString()}
              />
            </div>
          </div>

          {/* Breakdowns */}
          <div className="grid gap-6 lg:grid-cols-3">
            <Bars
              title="By status"
              data={sortedEntries(d?.by_status)}
              empty="No conversations yet."
            />
            <Bars
              title="By reason"
              data={sortedEntries(d?.by_reason)}
              empty="No reasons recorded."
            />
            <Bars
              title="By tenant"
              data={sortedEntries(d?.by_tenant)}
              empty="No tenants yet."
            />
          </div>
        </>
      )}
    </div>
  );
}
