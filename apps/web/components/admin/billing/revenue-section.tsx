"use client";

import { TrendingUp, Users, ChartLine, UserPlus } from "lucide-react";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { formatCurrency, formatNumber } from "@/components/admin/metrics/format";

export interface RevenueData {
  currency: string;
  mrr: number;
  arr: number;
  newTrials30d: number;
  cancelled30d: number;
  churnRate: number;
  activeCount: number;
  generatedAt: string;
}

interface RevenueSectionProps {
  data: RevenueData | null;
  loading: boolean;
}

export function RevenueSection({ data, loading }: RevenueSectionProps) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <KpiTile
        label="MRR"
        value={data ? formatCurrency(data.mrr, data.currency) : "—"}
        hint={data ? `${formatNumber(data.activeCount)} active` : undefined}
        icon={ChartLine}
        loading={loading}
      />
      <KpiTile
        label="ARR"
        value={data ? formatCurrency(data.arr, data.currency) : "—"}
        hint="MRR × 12"
        icon={TrendingUp}
        loading={loading}
      />
      <KpiTile
        label="Churn rate"
        value={data ? `${(data.churnRate * 100).toFixed(1)}%` : "—"}
        hint={data ? `${formatNumber(data.cancelled30d)} cancelled / 30d` : undefined}
        icon={Users}
        loading={loading}
      />
      <KpiTile
        label="New trials"
        value={data ? formatNumber(data.newTrials30d) : "—"}
        hint="last 30 days"
        icon={UserPlus}
        loading={loading}
      />
    </div>
  );
}
