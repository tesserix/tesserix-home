"use client";

// Client half of the super-admin dashboard. The server page fetches
// DashboardData from /api/admin/dashboard and hands it down as a plain prop;
// this renders the polished KPI row, the lead-pipeline funnel chart, and the
// orders-by-status donut using the shared admin charts kit.

import * as React from "react";
import Link from "next/link";
import { Building2, Store, Users, Boxes, ArrowRight } from "lucide-react";

import {
  AnalyticsShell,
  BarChartCard,
  DonutChartCard,
  KpiCard,
  type ChartSeries,
  type DonutSlice,
} from "@/components/admin/charts";

export interface DashboardData {
  tenants: { total: number; active: number };
  stores: { total: number };
  leads: { total: number; by_status: Record<string, number> };
  apps: { active: number };
  generated_at: string;
}

// Canonical lead lifecycle order, top → bottom of the funnel.
const LEAD_STATUS_ORDER: ReadonlyArray<string> = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
];

const LEAD_LABEL: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  lost: "Lost",
};

// Slice colors keyed to lifecycle meaning rather than the rotating palette so
// "converted" reads green and "lost" reads red at a glance.
const LEAD_COLOR: Record<string, string> = {
  new: "var(--chart-1)",
  contacted: "var(--chart-2)",
  qualified: "var(--chart-3)",
  converted: "#10b981",
  lost: "#ef4444",
};

interface LeadRow extends Record<string, unknown> {
  status: string;
  label: string;
  count: number;
}

const LEAD_SERIES: readonly ChartSeries[] = [{ dataKey: "count", name: "Leads" }];

function buildLeadRows(byStatus: Record<string, number>): LeadRow[] {
  return LEAD_STATUS_ORDER.map((status) => ({
    status,
    label: LEAD_LABEL[status] ?? status,
    count: byStatus[status] ?? 0,
  }));
}

function buildLeadSlices(rows: readonly LeadRow[]): DonutSlice[] {
  return rows
    .filter((r) => r.count > 0)
    .map((r) => ({
      name: r.label,
      value: r.count,
      color: LEAD_COLOR[r.status],
    }));
}

export function DashboardContent({ data }: { data: DashboardData }) {
  const leadRows = React.useMemo(
    () => buildLeadRows(data.leads.by_status),
    [data.leads.by_status],
  );
  const leadSlices = React.useMemo(() => buildLeadSlices(leadRows), [leadRows]);

  const converted = data.leads.by_status.converted ?? 0;
  const conversionRate =
    data.leads.total > 0 ? Math.round((converted / data.leads.total) * 100) : 0;

  return (
    <AnalyticsShell
      title="Platform overview"
      description="Cross-product counts pulled live from tesserix-postgres and mark8ly-postgres."
      filters={
        <span className="text-xs text-muted-foreground">
          Generated{" "}
          <time dateTime={data.generated_at}>
            {new Date(data.generated_at).toLocaleString()}
          </time>
        </span>
      }
      columns={2}
    >
      {/* Headline KPIs */}
      <AnalyticsShell.Section span="full">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Active tenants"
            value={data.tenants.active.toLocaleString()}
            sub={`${data.tenants.total.toLocaleString()} total`}
            tone={data.tenants.active > 0 ? "positive" : "neutral"}
            icon={Users}
            href="/admin/apps/mark8ly/tenants"
          />
          <KpiCard
            label="Stores"
            value={data.stores.total.toLocaleString()}
            icon={Store}
            href="/admin/apps/mark8ly/tenants"
          />
          <KpiCard
            label="Active products"
            value={data.apps.active.toLocaleString()}
            icon={Boxes}
            href="/admin/apps"
          />
          <KpiCard
            label="Leads"
            value={data.leads.total.toLocaleString()}
            sub={
              data.leads.total > 0 ? `${conversionRate}% converted` : "none yet"
            }
            tone={
              data.leads.total === 0
                ? "neutral"
                : conversionRate >= 20
                  ? "positive"
                  : "info"
            }
            icon={Building2}
            href="/admin/apps/mark8ly/leads"
          />
        </div>
      </AnalyticsShell.Section>

      {/* Lead pipeline funnel */}
      <BarChartCard<LeadRow>
        title="Leads pipeline"
        description="Count of leads at each lifecycle stage"
        data={leadRows}
        categoryKey="label"
        series={LEAD_SERIES}
        layout="vertical"
        showGrid={false}
        emptyMessage="No leads yet — import a CSV or paste a JSON dump on the leads page."
        height={300}
        action={
          <Link
            href="/admin/apps/mark8ly/leads"
            className="flex items-center gap-1 text-xs text-foreground/70 hover:text-foreground"
          >
            Manage <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        }
      />

      {/* Pipeline composition */}
      <DonutChartCard
        title="Pipeline composition"
        description="Share of leads by stage"
        data={leadSlices}
        centerLabel
        centerCaption="leads"
        emptyMessage="No leads to break down yet."
        height={300}
      />
    </AnalyticsShell>
  );
}
