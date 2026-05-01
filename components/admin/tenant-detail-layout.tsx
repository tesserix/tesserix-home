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
import { useTenantBilling } from "@/lib/admin/use-billing";
import { PlanBadge } from "@/components/admin/billing/plan-badge";
import { StatusBadge } from "@/components/admin/billing/status-badge";
import { DunningPill } from "@/components/admin/billing/dunning-pill";
import { PlanChangeTimeline } from "@/components/admin/billing/plan-change-timeline";
import { MarginCard } from "@/components/admin/billing/margin-card";
import type { ProductConfig } from "@/lib/products/types";

interface TenantDetailLayoutProps {
  config: ProductConfig;
  tenantId: string;
}

export function TenantDetailLayout({ config, tenantId }: TenantDetailLayoutProps) {
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("24h");
  const identity = useTenantIdentity(tenantId);
  const metrics = useTenantMetrics(config.id, tenantId, timeWindow);
  const hasBilling = Boolean(config.pricingByPlan);
  const billing = useTenantBilling(hasBilling ? config.id : "", hasBilling ? tenantId : "");

  async function handleRefresh() {
    await Promise.all([metrics.mutate(), identity.mutate(), billing.mutate()]);
  }

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
            <TimeWindowPicker value={timeWindow} onChange={setTimeWindow} />
            <RefreshControl onRefresh={handleRefresh} loading={metrics.isValidating} />
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

        {/* Section E — Subscription */}
        {hasBilling ? (
          <MetricsSection
            id="section-subscription"
            title="Subscription"
            lastRefreshedAt={billing.data?.generatedAt}
            error={billing.error ? "Could not load subscription." : undefined}
          >
            {billing.data?.subscription ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <PlanBadge plan={billing.data.subscription.plan} />
                  <StatusBadge status={billing.data.subscription.status} />
                  <DunningPill
                    state={
                      ["past_due", "incomplete"].includes(billing.data.subscription.status)
                        ? "retrying"
                        : billing.data.subscription.status === "unpaid"
                          ? "exhausted"
                          : null
                    }
                  />
                  {billing.data.subscription.cancel_at_period_end ? (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700">
                      Cancels at period end
                    </span>
                  ) : null}
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Period start</dt>
                    <dd className="mt-1 tabular-nums">
                      {billing.data.subscription.current_period_start
                        ? new Date(billing.data.subscription.current_period_start).toLocaleDateString()
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Period end</dt>
                    <dd className="mt-1 tabular-nums">
                      {billing.data.subscription.current_period_end
                        ? new Date(billing.data.subscription.current_period_end).toLocaleDateString()
                        : "—"}
                    </dd>
                  </div>
                  {billing.data.trial ? (
                    <>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Trial ends in</dt>
                        <dd className="mt-1 tabular-nums">
                          {billing.data.trial.daysRemaining != null
                            ? `${billing.data.trial.daysRemaining}d`
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Conversion</dt>
                        <dd className="mt-1 capitalize">{billing.data.trial.conversionLikelihood}</dd>
                      </div>
                    </>
                  ) : null}
                  {billing.data.lifetimeRevenue ? (
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">Lifetime revenue</dt>
                      <dd className="mt-1 tabular-nums">
                        {formatCurrency(billing.data.lifetimeRevenue.amount, billing.data.lifetimeRevenue.currency)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {billing.data.planHistory.length > 0 ? (
                  <div className="space-y-2 border-t border-border pt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Plan history</p>
                    <PlanChangeTimeline changes={billing.data.planHistory} />
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No subscription on file for this tenant.</p>
            )}
          </MetricsSection>
        ) : null}

        {/* Section F — Margin */}
        {hasBilling && billing.data?.margin ? (
          <MetricsSection
            id="section-margin"
            title="Estimated margin"
            lastRefreshedAt={billing.data.generatedAt}
          >
            <MarginCard
              revenue={billing.data.margin.revenue}
              infraCost={billing.data.margin.infraCost}
              margin={billing.data.margin.margin}
              currency={billing.data.margin.currency}
              inTrial={billing.data.margin.inTrial}
              productName={config.name}
            />
          </MetricsSection>
        ) : null}
      </div>
    </div>
  );
}
