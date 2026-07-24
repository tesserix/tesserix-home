"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";

interface UptimeRow {
  product_id: string;
  tenant_id: string;
  hostname: string;
  probes: number;
  successes: number;
  uptime: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  last_probed_at: string;
  last_ok: boolean;
  last_error: string | null;
  last_status: number | null;
}

interface Response {
  hours: number;
  rows: UptimeRow[];
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const WINDOWS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 1, label: "1h" },
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 24 * 7, label: "7d" },
];

const PRODUCT_TONE: Record<string, string> = {
  mark8ly: "bg-emerald-50 text-emerald-700",
  homechef: "bg-amber-50 text-amber-700",
  fanzone: "bg-violet-50 text-violet-700",
};

export default function UptimePage() {
  const [windowHours, setWindowHours] = useState(24);
  const { data, error, isLoading } = useSWR<Response>(
    `/api/admin/uptime?hours=${windowHours}`,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 60_000 },
  );

  const rows = data?.rows ?? [];
  const totalProbed = rows.reduce((s, r) => s + r.probes, 0);
  const totalOk = rows.reduce((s, r) => s + r.successes, 0);
  const overallUptime = totalProbed > 0 ? totalOk / totalProbed : 1;
  const downNow = rows.filter((r) => !r.last_ok).length;
  const slowSlowest = rows
    .filter((r) => r.p95_latency_ms !== null)
    .sort((a, b) => (b.p95_latency_ms ?? 0) - (a.p95_latency_ms ?? 0))[0];

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Synthetic uptime"
        description="External probes against tenant storefronts. Cron-driven, every 5 minutes."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile
            label="Tenants tracked"
            value={String(rows.length)}
            hint="active storefronts"
            loading={isLoading}
          />
          <KpiTile
            label={`Overall uptime (${data?.hours ?? windowHours}h)`}
            value={`${(overallUptime * 100).toFixed(2)}%`}
            hint={`${totalOk} / ${totalProbed} probes`}
            loading={isLoading}
          />
          <KpiTile
            label="Down now"
            value={String(downNow)}
            hint="last probe failed"
            loading={isLoading}
          />
          <KpiTile
            label="Slowest p95"
            value={
              slowSlowest && slowSlowest.p95_latency_ms !== null
                ? `${slowSlowest.p95_latency_ms} ms`
                : "—"
            }
            hint={slowSlowest?.hostname}
            loading={isLoading}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-1">
          {WINDOWS.map((w) => {
            const active = windowHours === w.hours;
            return (
              <button
                key={w.hours}
                onClick={() => setWindowHours(w.hours)}
                aria-pressed={active}
                className={
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
                  (active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50")
                }
              >
                Last {w.label}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load uptime data.
          </div>
        )}

        {!isLoading && rows.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No probe data yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The probe cron runs every 5 minutes. Once active stores have a
              storefront slug, results will appear here.
            </p>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Hostname</th>
                <th className="px-4 py-3">Now</th>
                <th className="px-4 py-3">Uptime</th>
                <th className="px-4 py-3 tabular-nums">p50</th>
                <th className="px-4 py-3 tabular-nums">p95</th>
                <th className="px-4 py-3">Probes</th>
                <th className="px-4 py-3">Last probed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.product_id}-${r.tenant_id}-${r.hostname}`}
                  className="border-b border-border last:border-0 hover:bg-muted/30"
                >
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PRODUCT_TONE[r.product_id] ?? "bg-muted"}`}
                    >
                      {r.product_id}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/apps/${r.product_id}/tenants/${r.tenant_id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {r.hostname}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <NowDot row={r} />
                  </td>
                  <td className="px-4 py-3">
                    <UptimePercent value={r.uptime} />
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums">
                    {r.p50_latency_ms !== null ? `${r.p50_latency_ms} ms` : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums">
                    {r.p95_latency_ms !== null ? `${r.p95_latency_ms} ms` : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                    {r.successes} / {r.probes}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                    {timeAgo(r.last_probed_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function NowDot({ row }: { row: UptimeRow }) {
  if (row.last_ok) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-emerald-700"
        title={`HTTP ${row.last_status ?? "—"}`}
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
        up
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700"
      title={row.last_error ?? "down"}
    >
      <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden="true" />
      {row.last_error ?? "down"}
    </span>
  );
}

function UptimePercent({ value }: { value: number }) {
  const pct = (value * 100).toFixed(2);
  const tone =
    value >= 0.999
      ? "text-emerald-700"
      : value >= 0.99
        ? "text-amber-700"
        : "text-rose-700";
  return <span className={`text-sm tabular-nums ${tone}`}>{pct}%</span>;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
