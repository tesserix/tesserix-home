"use client";

import useSWR from "swr";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatCount, formatINR, titleCase } from "@/lib/products/homechef/format";
import type { AdminAnalytics } from "@/lib/products/homechef/contracts";

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}

export default function HomechefAnalyticsPage() {
  const { data, isLoading } = useSWR<AdminAnalytics>(["/analytics"], swrFetcher);

  const byStatus = Object.entries(data?.ordersByStatus ?? {});
  const max = byStatus.reduce((m, [, v]) => Math.max(m, v), 0) || 1;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Analytics</h1>
        <p className="text-sm text-muted-foreground">Platform performance</p>
      </div>

      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile label="Total revenue" value={formatINR(data.overview.totalRevenue)} />
            <Tile label="Total orders" value={formatCount(data.overview.totalOrders)} />
            <Tile label="Avg order value" value={formatINR(data.overview.avgOrderValue)} />
            <Tile label="Active users" value={formatCount(data.overview.activeUsers)} />
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase text-muted-foreground">
              Orders by status
            </h2>
            {byStatus.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data.</p>
            ) : (
              <div className="space-y-3 rounded-lg border border-border p-4">
                {byStatus.map(([status, count]) => (
                  <div key={status}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="text-foreground">{titleCase(status)}</span>
                      <span className="font-medium text-foreground tabular-nums">
                        {formatCount(count)}
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
        </>
      )}
    </div>
  );
}
