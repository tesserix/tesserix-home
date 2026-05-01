"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Database, Activity, Info, ArrowUpFromLine } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tesserix/web";

import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { SparklineCard } from "@/components/admin/metrics/sparkline-card";
import { TimeWindowPicker, type TimeWindow } from "@/components/admin/metrics/time-window-picker";
import { RefreshControl } from "@/components/admin/metrics/refresh-control";
import { MetricsSection } from "@/components/admin/metrics/section";
import { formatBytes, formatCurrency, formatNumber } from "@/components/admin/metrics/format";
import { useTenantIdentity, useTenantMetrics } from "@/lib/admin/use-metrics";
import type { ProductConfig } from "@/lib/products/types";

interface TenantDetailLayoutProps {
  config: ProductConfig;
  tenantId: string;
}

export function TenantDetailLayout({ config, tenantId }: TenantDetailLayoutProps) {
  const [window, setWindow] = useState<TimeWindow>("24h");
  const identity = useTenantIdentity(tenantId);
  const metrics = useTenantMetrics(config.id, tenantId, window);

  const tenant = identity.data?.tenant;
  const data = metrics.data;
  const generatedAt = data?.generatedAt;

  const reqCurrent = data?.activity.requestRate?.current ?? 0;
  const reqLabel = `${formatNumber(reqCurrent)} req/s`;

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title={tenant?.name ?? tenantId} />
      <div className="flex-1 space-y-8 p-6">
        <div className="flex items-center justify-between">
          <Link
            href={`/admin/apps/${config.id}/tenants`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> All tenants
          </Link>
          <div className="flex items-center gap-2">
            <TimeWindowPicker value={window} onChange={setWindow} />
            <RefreshControl onRefresh={() => void metrics.mutate()} loading={metrics.isValidating} />
          </div>
        </div>

        {/* Section A — Identity */}
        <MetricsSection id="section-identity" title="Identity">
          {identity.error ? (
            <p className="text-sm text-destructive">Could not load tenant.</p>
          ) : tenant ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Status</dt>
                <dd className="mt-1 capitalize">{tenant.status}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Owner email</dt>
                <dd className="mt-1 truncate font-mono text-xs">{tenant.owner_email}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
                <dd className="mt-1">{new Date(tenant.created_at).toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Tenant ID</dt>
                <dd className="mt-1 truncate font-mono text-xs">{tenant.id}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </MetricsSection>

        {/* Section B — Activity */}
        <MetricsSection
          id="section-activity"
          title="Activity"
          lastRefreshedAt={generatedAt}
          error={metrics.error ? "Could not load activity metrics." : undefined}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <KpiTile
              label="Storage"
              value={data ? formatBytes(data.activity.storageBytes) : "—"}
              hint="estimated from row share"
              icon={Database}
              loading={metrics.isLoading}
            />
            {config.rowCountTables.map((t) => (
              <KpiTile
                key={t.label}
                label={t.label}
                value={data ? formatNumber(data.activity.rowCounts[t.label] ?? 0) : "—"}
                loading={metrics.isLoading}
              />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <SparklineCard
              label="Requests"
              currentLabel={reqLabel}
              series={data?.activity.requestRate?.sparkline ?? []}
              formatTooltipValue={(v) => `${formatNumber(v)} req/s`}
              loading={metrics.isLoading}
            />
            <SparklineCard
              label="Bandwidth in"
              currentLabel="—"
              series={data?.activity.bandwidth?.inSparkline ?? []}
              formatTooltipValue={(v) => `${formatBytes(v)}/s`}
              loading={metrics.isLoading}
            />
            <SparklineCard
              label="Bandwidth out"
              currentLabel="—"
              series={data?.activity.bandwidth?.outSparkline ?? []}
              formatTooltipValue={(v) => `${formatBytes(v)}/s`}
              loading={metrics.isLoading}
            />
          </div>
        </MetricsSection>

        {/* Section C — Email */}
        <MetricsSection
          id="section-email"
          title="Email activity"
          fixedWindowLabel="Last 30 days (fixed)"
          lastRefreshedAt={generatedAt}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <KpiTile label="Sent" value={data ? formatNumber(data.email.sent) : "—"} loading={metrics.isLoading} />
            <KpiTile label="Delivered" value={data ? formatNumber(data.email.delivered) : "—"} loading={metrics.isLoading} />
            <KpiTile label="Opens" value={data ? formatNumber(data.email.opens) : "—"} loading={metrics.isLoading} />
            <KpiTile label="Bounces" value={data ? formatNumber(data.email.bounces) : "—"} loading={metrics.isLoading} />
          </div>
        </MetricsSection>

        {/* Section D — Cost proxy */}
        <MetricsSection
          id="section-cost"
          title={
            <span className="inline-flex items-center gap-2">
              Estimated cost share
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="Cost attribution methodology">
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm">
                  Proxy allocation, not direct measurement. Divides {config.name}&apos;s total
                  GCP cost by this tenant&apos;s proportional share of requests, storage, and
                  egress. Per-tenant infrastructure cost is not individually metered.
                </TooltipContent>
              </Tooltip>
            </span>
          }
          lastRefreshedAt={generatedAt}
        >
          {data?.cost ? (
            <div className="space-y-3">
              <p className="text-3xl font-semibold tabular-nums">
                {formatCurrency(data.cost.estimatedCost, data.cost.currency)}
              </p>
              <p className="text-xs text-muted-foreground">
                Allocated from {config.name} total of{" "}
                {formatCurrency(data.cost.productTotalCost, data.cost.currency)} ·{" "}
                {(data.cost.breakdown.requests.weight * 100).toFixed(0)}% requests,{" "}
                {(data.cost.breakdown.storage.weight * 100).toFixed(0)}% storage,{" "}
                {(data.cost.breakdown.egress.weight * 100).toFixed(0)}% egress
              </p>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-3 w-3 text-muted-foreground" />
                  <dt className="text-muted-foreground">Requests share</dt>
                  <dd className="ml-auto tabular-nums">{(data.cost.breakdown.requests.raw * 100).toFixed(2)}%</dd>
                </div>
                <div className="flex items-center gap-2">
                  <Database className="h-3 w-3 text-muted-foreground" />
                  <dt className="text-muted-foreground">Storage share</dt>
                  <dd className="ml-auto tabular-nums">{(data.cost.breakdown.storage.raw * 100).toFixed(2)}%</dd>
                </div>
                <div className="flex items-center gap-2">
                  <ArrowUpFromLine className="h-3 w-3 text-muted-foreground" />
                  <dt className="text-muted-foreground">Egress share</dt>
                  <dd className="ml-auto tabular-nums">{(data.cost.breakdown.egress.raw * 100).toFixed(2)}%</dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Cost share unavailable.</p>
          )}
        </MetricsSection>
      </div>
    </div>
  );
}
