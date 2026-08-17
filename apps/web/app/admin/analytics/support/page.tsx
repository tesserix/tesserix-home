"use client";

import * as React from "react";
import useSWR from "swr";
import { Badge, Card, CardContent } from "@tesserix/web";
import { cn } from "@/lib/utils";
import {
  AnalyticsShell,
  BarChartCard,
  type ChartSeries,
} from "@/components/admin/charts";

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
  // id -> friendly name (mark8ly store names + humanized product labels);
  // added by the proxy. Missing ids fall back to the raw id.
  tenant_names?: Record<string, string>;
}

const fetcher = (url: string) =>
  fetch(url, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`load failed (${r.status})`);
    return r.json() as Promise<PlatformSupportStats>;
  });

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

type KpiTone = "neutral" | "positive" | "warning" | "critical" | "info";

const KPI_ACCENT: Record<KpiTone, string> = {
  neutral: "before:bg-border",
  positive: "before:bg-emerald-500",
  warning: "before:bg-amber-500",
  critical: "before:bg-red-500",
  info: "before:bg-sky-500",
};

const KPI_VALUE_COLOR: Record<KpiTone, string> = {
  neutral: "text-foreground",
  positive: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
};

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

const BADGE_FOR_TONE: Record<KpiTone, BadgeVariant> = {
  neutral: "neutral",
  positive: "success",
  warning: "warning",
  critical: "error",
  info: "info",
};

function KpiCard({
  label,
  value,
  sub,
  tone = "neutral",
  badge,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: KpiTone;
  /** Optional status pill (e.g. "High", "Healthy"). */
  badge?: string;
}) {
  return (
    <Card
      className={cn(
        "relative overflow-hidden",
        // Left accent rail, color-coded by tone.
        "before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-['']",
        KPI_ACCENT[tone],
      )}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm text-muted-foreground">{label}</span>
          {badge ? (
            <Badge variant={BADGE_FOR_TONE[tone]} className="shrink-0">
              {badge}
            </Badge>
          ) : null}
        </div>
        <div
          className={cn(
            "mt-1 text-2xl font-semibold tabular-nums",
            KPI_VALUE_COLOR[tone],
          )}
        >
          {value}
        </div>
        {sub ? (
          <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

function formatDuration(seconds: number | undefined): string {
  const s = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
  if (s <= 0) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function pct(n: number, d: number): number {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}

function rate(n: number, d: number): string {
  return `${pct(n, d)}%`;
}

// A single bar row: a friendly label plus its numeric count. `BarChartCard`
// plots `count` and uses `label` as the category axis.
interface BarRow extends Record<string, unknown> {
  label: string;
  count: number;
}

function toBarRows(
  rec: Record<string, number> | undefined,
  rename?: (key: string) => string,
): BarRow[] {
  return Object.entries(rec ?? {})
    .map(([key, count]): BarRow => ({
      label: rename ? rename(key) : key,
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

const COUNT_SERIES: readonly ChartSeries[] = [
  { dataKey: "count", name: "Conversations" },
];

// Color-code tones derived from the live numbers.

/** Escalation pressure: amber when a sizable share goes to humans, red when high. */
function escalationTone(escalated: number, total: number): KpiTone {
  const p = pct(escalated, total);
  if (total === 0) return "neutral";
  if (p >= 40) return "critical";
  if (p >= 20) return "warning";
  return "positive";
}

function csatTone(csat: number | undefined, feedbackCount: number): KpiTone {
  if (!feedbackCount || !csat) return "neutral";
  if (csat >= 4) return "positive";
  if (csat >= 3) return "warning";
  return "critical";
}

function resolvedTone(resolvedRate: number, feedbackCount: number): KpiTone {
  if (!feedbackCount) return "neutral";
  const p = Math.round(resolvedRate * 100);
  if (p >= 80) return "positive";
  if (p >= 50) return "warning";
  return "critical";
}

export default function PlatformSupportAnalyticsPage() {
  const { data, error, isLoading, isValidating } = useSWR<PlatformSupportStats>(
    "/api/admin/analytics/support",
    fetcher,
    { refreshInterval: REFRESH },
  );

  const d = data;
  const loading = isLoading && !d;

  const total = d?.total ?? 0;
  const escalated = d?.escalated ?? 0;
  const aiResolved = d?.ai_resolved ?? 0;
  const open = d?.open ?? 0;
  const csat = d?.csat ?? 0;
  const feedbackCount = d?.feedback_count ?? 0;
  const resolvedRate = d?.resolved_rate ?? 0;

  const escTone = escalationTone(escalated, total);
  const escBadge =
    total === 0
      ? undefined
      : escTone === "critical"
        ? "High"
        : escTone === "warning"
          ? "Elevated"
          : "Healthy";

  const csTone = csatTone(csat, feedbackCount);
  const resTone = resolvedTone(resolvedRate, feedbackCount);

  const statusRows = toBarRows(d?.by_status);
  const reasonRows = toBarRows(d?.by_reason);
  const tenantRows = toBarRows(d?.by_tenant, (id) => d?.tenant_names?.[id] ?? id);

  return (
    <AnalyticsShell
      title="Support analytics"
      description="Otto support chat across all tenants · live (30s refresh)"
      live={isValidating ? "Updating…" : "Live"}
      liveTone="live"
      columns={3}
    >
      {error ? (
        <AnalyticsShell.Section span="full">
          <Card>
            <CardContent className="p-4 text-sm text-red-600 dark:text-red-400">
              Couldn&apos;t load support analytics: {(error as Error).message}
            </CardContent>
          </Card>
        </AnalyticsShell.Section>
      ) : (
        <>
          {/* Volume */}
          <AnalyticsShell.Section span="full" title="Volume">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <KpiCard
                label="Total conversations"
                value={total.toLocaleString()}
                tone="neutral"
              />
              <KpiCard
                label="Open"
                value={open.toLocaleString()}
                sub="pending + active"
                tone={open > 0 ? "info" : "neutral"}
              />
              <KpiCard
                label="AI-resolved"
                value={aiResolved.toLocaleString()}
                sub={`${rate(aiResolved, total)} of all`}
                tone={total > 0 && aiResolved > 0 ? "positive" : "neutral"}
              />
              <KpiCard
                label="Escalated to human"
                value={escalated.toLocaleString()}
                sub={`${rate(escalated, total)} of all`}
                tone={escTone}
                badge={escBadge}
              />
            </div>
          </AnalyticsShell.Section>

          {/* Quality & efficiency */}
          <AnalyticsShell.Section span="full" title="Quality & efficiency">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <KpiCard
                label="Avg resolution time"
                value={formatDuration(d?.avg_resolution_seconds)}
                sub="created → closed"
                tone="neutral"
              />
              <KpiCard
                label="CSAT"
                value={csat ? `${csat.toFixed(1)} / 5` : "—"}
                sub="post-case rating"
                tone={csTone}
              />
              <KpiCard
                label="Resolved rate"
                value={feedbackCount ? `${Math.round(resolvedRate * 100)}%` : "—"}
                sub="customer-reported"
                tone={resTone}
              />
              <KpiCard
                label="Feedback responses"
                value={feedbackCount.toLocaleString()}
                tone="neutral"
              />
            </div>
          </AnalyticsShell.Section>

          {/* Breakdowns */}
          <BarChartCard<BarRow>
            title="By status"
            description="Conversation lifecycle distribution"
            data={statusRows}
            categoryKey="label"
            series={COUNT_SERIES}
            layout="vertical"
            loading={loading}
            emptyMessage="No conversations yet."
            height={300}
          />
          <BarChartCard<BarRow>
            title="By reason"
            description="Why customers reached out"
            data={reasonRows}
            categoryKey="label"
            series={COUNT_SERIES}
            layout="vertical"
            loading={loading}
            emptyMessage="No reasons recorded."
            height={300}
          />
          <BarChartCard<BarRow>
            title="By tenant"
            description="Volume per store / product"
            data={tenantRows}
            categoryKey="label"
            series={COUNT_SERIES}
            layout="vertical"
            loading={loading}
            emptyMessage="No tenants yet."
            height={300}
          />
        </>
      )}
    </AnalyticsShell>
  );
}
