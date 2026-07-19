"use client";

import * as React from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@tesserix/web";

import { swrFetcher } from "@/lib/products/homechef/client";
import {
  formatCount,
  formatINR,
  formatRelative,
  titleCase,
} from "@/lib/products/homechef/format";
import type {
  Activity,
  AdminAnalytics,
  AdminStats,
} from "@/lib/products/homechef/contracts";
import {
  AnalyticsShell,
  BarChartCard,
  KpiCard,
  type ChartSeries,
  type KpiTone,
} from "@/components/admin/charts";

const REFRESH = 30_000; // real-time-ish: re-pull every 30s

function pct(n: number | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `${v >= 0 ? "▲" : "▼"} ${Math.abs(v).toFixed(1)}% vs prev.`;
}

// Orders-by-status row: status label + count. BarChartCard plots `count` and
// uses `label` as the (vertical) category axis.
interface StatusRow extends Record<string, unknown> {
  label: string;
  count: number;
}

const ORDERS_SERIES: readonly ChartSeries[] = [
  { dataKey: "count", name: "Orders", formatValue: formatCount },
];

function toStatusRows(rec: Record<string, number> | undefined): StatusRow[] {
  return Object.entries(rec ?? {})
    .map(([status, count]): StatusRow => ({ label: titleCase(status), count }))
    .sort((a, b) => b.count - a.count);
}

export default function HomechefAnalyticsPage() {
  const stats = useSWR<AdminStats>(["/stats"], swrFetcher, {
    refreshInterval: REFRESH,
  });
  const analytics = useSWR<AdminAnalytics>(["/analytics"], swrFetcher, {
    refreshInterval: REFRESH,
  });
  // /activities returns a bare array, not the { data } envelope.
  const activity = useSWR<Activity[]>(
    ["/activities", { limit: 12 }],
    swrFetcher,
    { refreshInterval: REFRESH },
  );

  const s = stats.data;
  const loading = stats.isLoading && !s;

  const statusRows = toStatusRows(analytics.data?.ordersByStatus);
  const activities = activity.data ?? [];

  const revenueUp = (s?.revenueChange ?? 0) >= 0;
  const ordersUp = (s?.ordersChange ?? 0) >= 0;
  const pendingTone: KpiTone = s?.pendingVerifications ? "warning" : "positive";

  return (
    <AnalyticsShell
      title="HomeChef analytics"
      description="Platform performance · live (30s refresh)"
      live={stats.isValidating ? "Updating…" : "Live"}
      liveTone="live"
      columns={2}
    >
      {/* Money & volume */}
      <AnalyticsShell.Section span="full" title="Money & volume">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Total revenue"
            value={formatINR(s?.revenue)}
            delta={s?.revenueChange != null ? pct(s.revenueChange) : undefined}
            deltaUp={revenueUp}
            tone={s?.revenueChange != null ? (revenueUp ? "positive" : "critical") : "neutral"}
          />
          <KpiCard
            label="Revenue today"
            value={formatINR(s?.revenueToday)}
            sub="since 00:00 UTC"
          />
          <KpiCard
            label="Total orders"
            value={formatCount(s?.totalOrders)}
            delta={s?.ordersChange != null ? pct(s.ordersChange) : undefined}
            deltaUp={ordersUp}
            tone={s?.ordersChange != null ? (ordersUp ? "positive" : "critical") : "neutral"}
          />
          <KpiCard label="Orders today" value={formatCount(s?.ordersToday)} />
        </div>
      </AnalyticsShell.Section>

      {/* People & efficiency */}
      <AnalyticsShell.Section span="full" title="People & efficiency">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Avg order value"
            value={formatINR(analytics.data?.overview.avgOrderValue)}
          />
          <KpiCard
            label="Total users"
            value={formatCount(s?.totalUsers)}
            delta={s?.newUsersToday ? `+${formatCount(s.newUsersToday)} today` : undefined}
            deltaUp
            tone={s?.newUsersToday ? "positive" : "neutral"}
          />
          <KpiCard
            label="Active users"
            value={formatCount(analytics.data?.overview.activeUsers)}
            tone="info"
          />
          <KpiCard
            label="Chefs"
            value={formatCount(s?.totalChefs)}
            sub={s?.pendingVerifications ? `${s.pendingVerifications} pending` : "all verified"}
            tone={pendingTone}
            badge={s?.pendingVerifications ? "Review" : undefined}
          />
        </div>
      </AnalyticsShell.Section>

      {/* Orders by status */}
      <BarChartCard<StatusRow>
        title="Orders by status"
        description="Order lifecycle distribution"
        data={statusRows}
        categoryKey="label"
        series={ORDERS_SERIES}
        layout="vertical"
        loading={loading}
        emptyMessage="No order data yet."
        height={320}
      />

      {/* Recent activity */}
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="flex-1">
          <div className="divide-y divide-border">
            {loading ? (
              <p className="py-2 text-sm text-muted-foreground">Loading…</p>
            ) : activities.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No recent activity.</p>
            ) : (
              activities.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {a.title}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {a.description}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelative(a.timestamp)}
                  </span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </AnalyticsShell>
  );
}
