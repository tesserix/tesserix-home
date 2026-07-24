"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { formatNumber } from "@/components/admin/metrics/format";

interface FunnelStats {
  totalStarted: number;
  emailVerified: number;
  completed: number;
  inFlight: number;
  abandoned: number;
  medianTimeToCompleteSeconds: number | null;
  last24h: { started: number; completed: number };
}

interface SessionRow {
  id: string;
  email: string;
  business_name: string | null;
  status: string;
  email_verified_at: string | null;
  completed_at: string | null;
  tenant_id: string | null;
  last_activity_at: string;
  created_at: string;
  is_abandoned: boolean;
  hours_idle: number;
}

interface OnboardingResponse {
  stats: FunnelStats;
  sessions: SessionRow[];
  filter: { status: string };
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const TABS: ReadonlyArray<{ value: "in_flight" | "completed" | "abandoned" | "all"; label: string }> = [
  { value: "in_flight", label: "In flight" },
  { value: "abandoned", label: "Abandoned" },
  { value: "completed", label: "Completed" },
  { value: "all", label: "All" },
];

export default function OnboardingFunnelPage() {
  const [filter, setFilter] = useState<typeof TABS[number]["value"]>("in_flight");
  const { data, error, isLoading } = useSWR<OnboardingResponse>(
    `/api/admin/apps/mark8ly/onboarding?status=${filter}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const stats = data?.stats;
  const verifyRate =
    stats && stats.totalStarted > 0
      ? Math.round((stats.emailVerified / stats.totalStarted) * 100)
      : null;
  const completionRate =
    stats && stats.emailVerified > 0
      ? Math.round((stats.completed / stats.emailVerified) * 100)
      : null;

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Onboarding funnel"
        description="Mark8ly tenants in the onboarding flow — drop-off, time-to-complete, and 24-hour throughput."
      />
      <div className="flex-1 space-y-6 p-6">
        {/* Funnel KPIs */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <KpiTile
            label="In flight"
            value={stats ? formatNumber(stats.inFlight) : "—"}
            hint="active in last 7d"
            loading={isLoading}
          />
          <KpiTile
            label="Email verified"
            value={
              stats
                ? `${formatNumber(stats.emailVerified)}${verifyRate !== null ? ` · ${verifyRate}%` : ""}`
                : "—"
            }
            hint="of all started"
            loading={isLoading}
          />
          <KpiTile
            label="Completed"
            value={
              stats
                ? `${formatNumber(stats.completed)}${completionRate !== null ? ` · ${completionRate}%` : ""}`
                : "—"
            }
            hint="of verified"
            loading={isLoading}
          />
          <KpiTile
            label="Abandoned"
            value={stats ? formatNumber(stats.abandoned) : "—"}
            hint="idle 7d+"
            loading={isLoading}
          />
          <KpiTile
            label="Median time to complete"
            value={formatDuration(stats?.medianTimeToCompleteSeconds ?? null)}
            hint="completed sessions"
            loading={isLoading}
          />
        </div>

        {/* 24h sub-strip */}
        {stats && (
          <p className="text-xs text-muted-foreground">
            Last 24 hours: {stats.last24h.started} started ·{" "}
            {stats.last24h.completed} completed
          </p>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load onboarding data.
          </div>
        )}

        {/* Filter tabs */}
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

        {/* Session list */}
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Business</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Last activity</th>
                <th className="px-4 py-3">Started</th>
              </tr>
            </thead>
            <tbody>
              {(data?.sessions ?? []).length === 0 && !isLoading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    No {filter.replace("_", " ")} sessions.
                  </td>
                </tr>
              ) : (
                data?.sessions.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-border last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3 font-medium">
                      {s.tenant_id ? (
                        <Link
                          href={`/admin/apps/mark8ly/tenants/${s.tenant_id}`}
                          className="hover:underline"
                        >
                          {s.business_name ?? "—"}
                        </Link>
                      ) : (
                        s.business_name ?? "—"
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{s.email}</td>
                    <td className="px-4 py-3">
                      <StatusPill row={s} />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <StageDots row={s} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                      {formatHoursIdle(s.hours_idle)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                      {new Date(s.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ row }: { row: SessionRow }) {
  if (row.status === "completed") {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700">
        completed
      </span>
    );
  }
  if (row.is_abandoned) {
    return (
      <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-xs text-rose-700">
        abandoned
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700">
      {row.status.replace(/_/g, " ")}
    </span>
  );
}

function StageDots({ row }: { row: SessionRow }) {
  // Three pips: started → email verified → completed. Filled = reached.
  const started = true;
  const verified = row.email_verified_at !== null;
  const completed = row.completed_at !== null;
  return (
    <div className="flex items-center gap-1.5" aria-label="Funnel stage">
      <Pip filled={started} title="Started" />
      <span className="h-px w-3 bg-border" aria-hidden="true" />
      <Pip filled={verified} title="Email verified" />
      <span className="h-px w-3 bg-border" aria-hidden="true" />
      <Pip filled={completed} title="Completed" />
    </div>
  );
}

function Pip({ filled, title }: { filled: boolean; title: string }) {
  return (
    <span
      title={title}
      className={
        "h-2 w-2 rounded-full " +
        (filled ? "bg-emerald-600" : "border border-border bg-transparent")
      }
    />
  );
}

function formatHoursIdle(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
