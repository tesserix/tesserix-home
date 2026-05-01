"use client";

import { useState } from "react";
import { Cpu, MemoryStick, Boxes, Database, GaugeCircle, Network } from "lucide-react";
import { Info } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { SparklineCard } from "@/components/admin/metrics/sparkline-card";
import { CostBreakdownStack } from "@/components/admin/metrics/cost-breakdown";
import { TimeWindowPicker, type TimeWindow } from "@/components/admin/metrics/time-window-picker";
import { RefreshControl } from "@/components/admin/metrics/refresh-control";
import { MetricsSection } from "@/components/admin/metrics/section";
import {
  formatBytes,
  formatCurrency,
  formatNumber,
} from "@/components/admin/metrics/format";
import { useDashboardCounts, useProductMetrics, type DashboardCounts } from "@/lib/admin/use-metrics";
import type { ProductConfig, KpiTileSpec } from "@/lib/products/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tesserix/web";

interface ProductOverviewLayoutProps {
  config: ProductConfig;
}

function resolveKpiValue(tile: KpiTileSpec, dash: DashboardCounts | undefined): { value: string; hint?: string } {
  if (!dash) return { value: "—", hint: tile.hint };
  switch (tile.key) {
    case "tenants_active":
      return { value: formatNumber(dash.tenants.active), hint: `${formatNumber(dash.tenants.total)} of total` };
    case "stores_total":
      return { value: formatNumber(dash.stores.total), hint: tile.hint };
    case "leads_total":
      return { value: formatNumber(dash.leads.total), hint: tile.hint };
    default:
      return { value: "—", hint: tile.hint };
  }
}

export function ProductOverviewLayout({ config }: ProductOverviewLayoutProps) {
  const [window, setWindow] = useState<TimeWindow>("24h");
  const { data, error, isLoading, mutate, isValidating } = useProductMetrics(config.id, window);
  const dashboard = useDashboardCounts();

  const generatedAt = data?.generatedAt;
  const cost = data?.cost ?? null;
  const resources = data?.resources;
  const email = data?.email;

  const cpuLabel = resources?.cpu ? `${formatNumber(resources.cpu.current)} cores` : "—";
  const memoryLabel = resources?.memory ? formatBytes(resources.memory.current) : "—";

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title={config.name} />
      <div className="flex-1 space-y-8 p-6">
        <div className="flex items-center justify-end gap-2">
          <TimeWindowPicker value={window} onChange={setWindow} />
          <RefreshControl onRefresh={() => void mutate()} loading={isValidating} />
        </div>

        {/* Section A — Business KPIs */}
        <MetricsSection
          id="section-business"
          title="Overview"
          error={dashboard.error ? "Could not load tenant/store/lead counts." : undefined}
        >
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            {config.businessKpiTiles.map((tile) => {
              const { value, hint } = resolveKpiValue(tile, dashboard.data);
              return (
                <KpiTile
                  key={tile.key}
                  label={tile.label}
                  value={value}
                  hint={hint}
                  href={tile.href}
                  loading={dashboard.isLoading}
                />
              );
            })}
          </div>
        </MetricsSection>

        {/* Section B — Resources */}
        <MetricsSection
          id="section-resources"
          title="Resources"
          lastRefreshedAt={generatedAt}
          error={error ? "Could not load resource metrics." : undefined}
        >
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <KpiTile
              label="CPU"
              value={cpuLabel}
              icon={Cpu}
              loading={isLoading}
              dataSource="Prometheus"
              lastRefreshedAt={generatedAt}
            />
            <KpiTile
              label="Memory"
              value={memoryLabel}
              icon={MemoryStick}
              loading={isLoading}
              dataSource="Prometheus"
              lastRefreshedAt={generatedAt}
            />
            <KpiTile
              label="Pods"
              value={resources?.pods ? formatNumber(resources.pods.count) : "—"}
              icon={Boxes}
              loading={isLoading}
              dataSource="Prometheus"
              lastRefreshedAt={generatedAt}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SparklineCard
              label="CPU 24h"
              currentLabel={cpuLabel}
              series={resources?.cpu?.sparkline ?? []}
              formatTooltipValue={(v) => `${formatNumber(v)} cores`}
              loading={isLoading}
            />
            <SparklineCard
              label="Memory 24h"
              currentLabel={memoryLabel}
              series={resources?.memory?.sparkline ?? []}
              formatTooltipValue={(v) => formatBytes(v)}
              loading={isLoading}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiTile
              label="DB size"
              value={resources?.db ? formatBytes(resources.db.sizeBytes) : "—"}
              icon={Database}
              loading={isLoading}
              dataSource="CNPG metrics"
              lastRefreshedAt={generatedAt}
            />
            <KpiTile
              label="Replication lag"
              value={resources?.db ? `${formatNumber(resources.db.replicationLagSeconds)}s` : "—"}
              icon={GaugeCircle}
              loading={isLoading}
              dataSource="CNPG metrics"
              lastRefreshedAt={generatedAt}
            />
            <KpiTile
              label="Active connections"
              value={resources?.db ? formatNumber(resources.db.activeConnections) : "—"}
              icon={Network}
              loading={isLoading}
              dataSource="CNPG metrics"
              lastRefreshedAt={generatedAt}
            />
          </div>
        </MetricsSection>

        {/* Section C — Cost */}
        <MetricsSection
          id="section-cost"
          title="Estimated cost"
          lastRefreshedAt={generatedAt}
          error={error ? "Could not load cost metrics." : undefined}
        >
          {cost ? (
            <div className="space-y-4">
              <div className="flex items-baseline gap-3">
                <p className="text-3xl font-semibold tabular-nums">{formatCurrency(cost.total, cost.currency)}</p>
                <span className="text-xs text-muted-foreground">{window} window · OpenCost</span>
              </div>
              <CostBreakdownStack
                total={cost.total}
                currency={cost.currency}
                breakdown={[
                  { label: "CPU", value: cost.breakdown.cpu, color: "bg-sky-400" },
                  { label: "RAM", value: cost.breakdown.ram, color: "bg-violet-400" },
                  { label: "Disk", value: cost.breakdown.pv, color: "bg-amber-400" },
                  { label: "Network", value: cost.breakdown.network, color: "bg-emerald-400" },
                  { label: "LB", value: cost.breakdown.loadBalancer, color: "bg-rose-400" },
                ]}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Cost metrics unavailable. {error ? error.message : "Check OpenCost reachability."}
            </p>
          )}
        </MetricsSection>

        {/* Section D — Email (always 30d) */}
        <MetricsSection
          id="section-email"
          title="Email activity"
          fixedWindowLabel="Last 30 days (fixed)"
          lastRefreshedAt={generatedAt}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-5">
            <KpiTile label="Sent" value={email ? formatNumber(email.sent) : "—"} loading={isLoading} />
            <KpiTile label="Delivered" value={email ? formatNumber(email.delivered) : "—"} loading={isLoading} />
            <KpiTile label="Opens" value={email ? formatNumber(email.opens) : "—"} loading={isLoading} />
            <KpiTile label="Bounces" value={email ? formatNumber(email.bounces) : "—"} loading={isLoading} />
            <KpiTile label="Unsubscribes" value={email ? formatNumber(email.unsubscribes) : "—"} loading={isLoading} />
          </div>
          {email?.sent === 0 ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="Why are these zero?">
                    <Info className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Email events are populated from the SendGrid Event Webhook into notification-service.
                  Until that pipeline lands and mark8ly sends are tagged with custom_args, these
                  remain zero.
                </TooltipContent>
              </Tooltip>
              No events recorded yet.
            </p>
          ) : null}
        </MetricsSection>
      </div>
    </div>
  );
}
