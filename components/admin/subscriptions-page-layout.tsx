"use client";

import { useMemo, useState } from "react";

import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { RefreshControl } from "@/components/admin/metrics/refresh-control";
import {
  SubscriptionsTable,
  type SortDir,
  type SortKey,
  type SubscriptionRowItem,
} from "@/components/admin/billing/subscriptions-table";
import { formatCurrency, formatNumber } from "@/components/admin/metrics/format";
import {
  useSubscriptionsList,
  type SubscriptionsFilter,
} from "@/lib/admin/use-billing";
import type { ProductConfig } from "@/lib/products/types";
import { cn } from "@/lib/utils";

const FILTER_OPTIONS: ReadonlyArray<{ value: SubscriptionsFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "trial", label: "Trial" },
  { value: "past_due", label: "Past due" },
  { value: "cancelled", label: "Cancelled" },
];

interface Props {
  config: ProductConfig;
}

function compareRows(a: SubscriptionRowItem, b: SubscriptionRowItem, key: SortKey): number {
  switch (key) {
    case "tenantName":
      return a.tenantName.localeCompare(b.tenantName);
    case "plan":
      return a.plan.localeCompare(b.plan);
    case "status":
      return a.status.localeCompare(b.status);
    case "mrr":
      return a.mrr - b.mrr;
    case "currentPeriodEnd": {
      const av = a.currentPeriodEnd ? new Date(a.currentPeriodEnd).getTime() : Number.MAX_SAFE_INTEGER;
      const bv = b.currentPeriodEnd ? new Date(b.currentPeriodEnd).getTime() : Number.MAX_SAFE_INTEGER;
      return av - bv;
    }
  }
}

export function SubscriptionsPageLayout({ config }: Props) {
  const [filter, setFilter] = useState<SubscriptionsFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("currentPeriodEnd");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const { data, error, isLoading, isValidating, mutate } = useSubscriptionsList(config.id, filter);

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sortedRows = useMemo(() => {
    if (!data?.rows) return [];
    const copy = [...data.rows];
    copy.sort((a, b) => {
      const r = compareRows(a, b, sortKey);
      return sortDir === "asc" ? r : -r;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Subscriptions" />
      <div className="flex-1 space-y-6 p-6">
        <div className="flex items-center justify-end">
          <RefreshControl onRefresh={async () => { await mutate(); }} loading={isValidating} />
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile
            label="Total MRR"
            value={data ? formatCurrency(data.summary.totalMrr, data.summary.currency) : "—"}
            hint={data ? `${formatNumber(data.summary.activeCount)} active` : undefined}
            loading={isLoading}
          />
          <KpiTile
            label="Trial"
            value={data ? formatNumber(data.summary.trialCount) : "—"}
            loading={isLoading}
          />
          <KpiTile
            label="Past due"
            value={data ? formatNumber(data.summary.pastDueCount) : "—"}
            loading={isLoading}
          />
          <KpiTile
            label="Cancelled this month"
            value={data ? formatNumber(data.summary.cancelledThisMonth) : "—"}
            loading={isLoading}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Subscription filter">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              role="tab"
              aria-selected={filter === opt.value}
              onClick={() => setFilter(opt.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                filter === opt.value
                  ? "border-foreground bg-foreground text-background"
                  : "border-border hover:border-foreground/40",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load subscriptions.
          </div>
        ) : null}

        <SubscriptionsTable
          rows={sortedRows}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          productId={config.id}
        />
      </div>
    </div>
  );
}
