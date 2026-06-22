"use client";

import useSWR from "swr";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatCount, formatINR, formatRelative, titleCase } from "@/lib/products/homechef/format";
import type {
  Activity,
  AdminAnalytics,
  AdminStats,
} from "@/lib/products/homechef/contracts";

const REFRESH = 30_000; // real-time-ish: re-pull every 30s

function Tile({
  label,
  value,
  sub,
  delta,
  deltaUp,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: string;
  deltaUp?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground tabular-nums">{value}</div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {sub ? <span className="text-muted-foreground">{sub}</span> : null}
        {delta ? (
          <span
            className={
              deltaUp
                ? "text-green-600 dark:text-green-400"
                : "text-red-600 dark:text-red-400"
            }
          >
            {delta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function pct(n: number | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `${v >= 0 ? "▲" : "▼"} ${Math.abs(v).toFixed(1)}% vs prev.`;
}

export default function HomechefAnalyticsPage() {
  const stats = useSWR<AdminStats>(["/stats"], swrFetcher, { refreshInterval: REFRESH });
  const analytics = useSWR<AdminAnalytics>(["/analytics"], swrFetcher, { refreshInterval: REFRESH });
  const activity = useSWR<{ data: Activity[] }>(
    ["/activities", { limit: 12 }],
    swrFetcher,
    { refreshInterval: REFRESH },
  );

  const s = stats.data;
  const byStatus = Object.entries(analytics.data?.ordersByStatus ?? {});
  const maxStatus = byStatus.reduce((m, [, v]) => Math.max(m, v), 0) || 1;
  const loading = stats.isLoading && !s;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Analytics</h1>
          <p className="text-sm text-muted-foreground">Platform performance · live (30s refresh)</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
          {stats.isValidating ? "updating…" : "live"}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {/* Revenue + orders with deltas */}
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">Money & volume</h2>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Tile
                label="Total revenue"
                value={formatINR(s?.revenue)}
                delta={s?.revenueChange != null ? pct(s.revenueChange) : undefined}
                deltaUp={(s?.revenueChange ?? 0) >= 0}
              />
              <Tile label="Revenue today" value={formatINR(s?.revenueToday)} sub="since 00:00 IST" />
              <Tile
                label="Total orders"
                value={formatCount(s?.totalOrders)}
                delta={s?.ordersChange != null ? pct(s.ordersChange) : undefined}
                deltaUp={(s?.ordersChange ?? 0) >= 0}
              />
              <Tile label="Orders today" value={formatCount(s?.ordersToday)} />
            </div>
          </div>

          {/* AOV + users + chefs */}
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">People & efficiency</h2>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Tile label="Avg order value" value={formatINR(analytics.data?.overview.avgOrderValue)} />
              <Tile
                label="Total users"
                value={formatCount(s?.totalUsers)}
                delta={s?.newUsersToday ? `+${formatCount(s.newUsersToday)} today` : undefined}
                deltaUp
              />
              <Tile label="Active users" value={formatCount(analytics.data?.overview.activeUsers)} />
              <Tile
                label="Chefs"
                value={formatCount(s?.totalChefs)}
                sub={s?.pendingVerifications ? `${s.pendingVerifications} pending` : "all verified"}
              />
            </div>
          </div>

          {/* Orders by status + recent activity, side by side */}
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">Orders by status</h2>
              {byStatus.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data.</p>
              ) : (
                <div className="space-y-3 rounded-lg border border-border p-4">
                  {byStatus.map(([status, count]) => (
                    <div key={status}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="text-foreground">{titleCase(status)}</span>
                        <span className="font-medium text-foreground tabular-nums">{formatCount(count)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-2 rounded-full bg-foreground"
                          style={{ width: `${Math.max(4, (count / maxStatus) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">Recent activity</h2>
              <div className="rounded-lg border border-border divide-y divide-border">
                {(activity.data?.data ?? []).length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">No recent activity.</p>
                ) : (
                  activity.data!.data.map((a) => (
                    <div key={a.id} className="flex items-start justify-between gap-3 p-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">{a.title}</div>
                        <div className="text-xs text-muted-foreground">{a.description}</div>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(a.timestamp)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
