"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { formatNumber } from "@/components/admin/metrics/format";

interface Summary {
  pending: number;
  processing: number;
  completedThisWeek: number;
  failed: number;
  oldestPendingHours: number | null;
}

interface Row {
  id: string;
  tenant_id: string;
  store_id: string;
  customer_email: string;
  requested_at: string;
  status: string;
  processed_at: string | null;
  notes: string | null;
  store_name: string | null;
  hours_pending: number;
}

interface Response {
  summary: Summary;
  rows: Row[];
  filter: { status: string };
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const TABS: ReadonlyArray<{ value: "pending" | "processing" | "completed" | "failed" | "all"; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
  { value: "all", label: "All" },
];

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700",
  processing: "bg-sky-500/15 text-sky-700",
  completed: "bg-emerald-500/15 text-emerald-700",
  failed: "bg-rose-500/15 text-rose-700",
};

// SLA visibility: GDPR requires erasure within 30 days. Anything past
// 14 days pending is in the warning zone.
const SLA_WARN_HOURS = 14 * 24;
const SLA_BREACH_HOURS = 30 * 24;

export default function ErasureRequestsPage() {
  const [filter, setFilter] = useState<typeof TABS[number]["value"]>("pending");
  const { data, error, isLoading } = useSWR<Response>(
    `/api/admin/erasure-requests?status=${filter}`,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 60_000 },
  );

  const s = data?.summary;

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="GDPR erasure queue"
        description="Customer erasure requests across all mark8ly tenants. Read-only — execution happens via mark8ly admin per tenant."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile
            label="Pending"
            value={s ? formatNumber(s.pending) : "—"}
            hint="awaiting action"
            loading={isLoading}
          />
          <KpiTile
            label="Processing"
            value={s ? formatNumber(s.processing) : "—"}
            hint="in flight"
            loading={isLoading}
          />
          <KpiTile
            label="Resolved this week"
            value={s ? formatNumber(s.completedThisWeek) : "—"}
            hint="last 7 days"
            loading={isLoading}
          />
          <KpiTile
            label="Oldest pending"
            value={formatHours(s?.oldestPendingHours ?? null)}
            hint={
              s && s.oldestPendingHours !== null && s.oldestPendingHours > SLA_WARN_HOURS
                ? "SLA: 30d max"
                : ""
            }
            loading={isLoading}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load erasure requests.
          </div>
        )}

        {s && s.failed > 0 && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm">
            {s.failed} failed request{s.failed === 1 ? "" : "s"} need investigation.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-1">
          {TABS.map((t) => {
            const active = filter === t.value;
            return (
              <button
                key={t.value}
                onClick={() => setFilter(t.value)}
                aria-pressed={active}
                className={
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
                  (active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50")
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Store</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Pending for</th>
                <th className="px-4 py-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).length === 0 && !isLoading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    No {filter} erasure requests.
                  </td>
                </tr>
              ) : (
                data?.rows.map((r) => {
                  const breached = r.hours_pending >= SLA_BREACH_HOURS;
                  const warn = r.hours_pending >= SLA_WARN_HOURS;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-border last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-4 py-3 font-mono text-xs">
                        {r.customer_email}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <Link
                          href={`/admin/apps/mark8ly/tenants/${r.tenant_id}`}
                          className="hover:underline"
                        >
                          {r.store_name ?? "—"}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[r.status] ?? "bg-muted"}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                        {new Date(r.requested_at).toLocaleString()}
                      </td>
                      <td
                        className={
                          "px-4 py-3 text-xs tabular-nums " +
                          (breached
                            ? "font-semibold text-rose-700"
                            : warn
                              ? "text-amber-700"
                              : "text-muted-foreground")
                        }
                      >
                        {r.status === "pending" || r.status === "processing"
                          ? formatHours(r.hours_pending)
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {r.notes ?? "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${days}d`;
}
