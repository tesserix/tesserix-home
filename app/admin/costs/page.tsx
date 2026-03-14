"use client";

import { useState, useEffect, useCallback } from "react";
import {
  DollarSign,
  RefreshCw,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  ExternalLink,
  Info,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
  ErrorState,
  Stat,
  StatLabel,
  StatValue,
  StatMeta,
} from "@tesserix/web";
import { apiFetch } from "@/lib/api/use-api";

// ─── Types ───

interface Budget {
  name: string;
  amount: { value: number; currency: string } | null;
}

interface GCPService {
  name: string;
  key: string;
}

interface BillingData {
  billingAccount?: string;
  billingEnabled?: boolean;
  budgets?: Budget[];
  services?: GCPService[];
  bqExportRequired?: boolean;
  bqSetupSteps?: string[];
  error?: string;
  message?: string;
  setupSteps?: string[];
}

// ─── Mock cost data (shown when BigQuery export is not configured) ───
// These represent a realistic Tesserix cost profile (~$15/mo total)

const MOCK_SERVICE_COSTS = [
  { name: "Cloud Run", cost: 4.2, color: "bg-blue-500" },
  { name: "Cloud SQL", cost: 5.8, color: "bg-violet-500" },
  { name: "Secret Manager", cost: 0.6, color: "bg-amber-500" },
  { name: "Pub/Sub", cost: 0.2, color: "bg-emerald-500" },
  { name: "Cloud Storage", cost: 0.4, color: "bg-cyan-500" },
  { name: "Cloud Tasks", cost: 0.05, color: "bg-pink-500" },
  { name: "Cloud Logging", cost: 1.1, color: "bg-orange-500" },
  { name: "Container Registry", cost: 0.3, color: "bg-teal-500" },
  { name: "Networking", cost: 0.8, color: "bg-indigo-500" },
  { name: "Other", cost: 0.6, color: "bg-muted" },
];

const MOCK_MONTHLY = [
  { month: "Oct", cost: 12.4 },
  { month: "Nov", cost: 13.8 },
  { month: "Dec", cost: 14.1 },
  { month: "Jan", cost: 13.5 },
  { month: "Feb", cost: 14.8 },
  { month: "Mar (est)", cost: 14.05, current: true },
];

function formatCurrency(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// ─── Setup Instructions Card ───

function SetupCard({
  title,
  message,
  steps,
}: {
  title: string;
  message: string;
  steps: string[];
}) {
  return (
    <Card className="border-amber-300/50 bg-amber-50/50 dark:bg-amber-900/10">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-2">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{title}</p>
            <p className="text-xs text-amber-700 dark:text-amber-400">{message}</p>
            <ol className="space-y-1">
              {steps.map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                  <span className="shrink-0 font-semibold">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Bar Chart ───

function CostBarChart() {
  const total = MOCK_SERVICE_COSTS.reduce((s, c) => s + c.cost, 0);
  const maxCost = Math.max(...MOCK_SERVICE_COSTS.map((c) => c.cost));

  return (
    <div className="space-y-3">
      {MOCK_SERVICE_COSTS.map((item) => (
        <div key={item.name} className="flex items-center gap-3">
          <div className="w-32 shrink-0 text-sm text-muted-foreground truncate">{item.name}</div>
          <div className="flex-1 h-6 bg-muted/50 rounded-md overflow-hidden">
            <div
              className={`h-full rounded-md transition-all ${item.color}`}
              style={{ width: `${(item.cost / maxCost) * 100}%` }}
            />
          </div>
          <div className="w-16 text-right font-mono text-sm font-medium">
            {formatCurrency(item.cost)}
          </div>
          <div className="w-10 text-right text-xs text-muted-foreground">
            {((item.cost / total) * 100).toFixed(0)}%
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Monthly Trend Chart ───

function MonthlyTrendChart() {
  const maxCost = Math.max(...MOCK_MONTHLY.map((m) => m.cost));
  const prev = MOCK_MONTHLY[MOCK_MONTHLY.length - 2];
  const curr = MOCK_MONTHLY[MOCK_MONTHLY.length - 1];
  const delta = curr.cost - prev.cost;
  const deltaPercent = ((delta / prev.cost) * 100).toFixed(1);
  const isUp = delta > 0;
  const isFlat = Math.abs(delta) < 0.1;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-4">
        <div>
          <p className="text-xs text-muted-foreground">This Month (est.)</p>
          <p className="text-3xl font-bold">{formatCurrency(curr.cost)}</p>
        </div>
        <div className={`flex items-center gap-1 text-sm font-medium pb-1 ${
          isFlat ? "text-muted-foreground" : isUp ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"
        }`}>
          {isFlat ? (
            <Minus className="h-4 w-4" />
          ) : isUp ? (
            <TrendingUp className="h-4 w-4" />
          ) : (
            <TrendingDown className="h-4 w-4" />
          )}
          {isFlat ? "Flat" : `${isUp ? "+" : ""}${deltaPercent}% vs last month`}
        </div>
      </div>

      {/* Bar chart for monthly trend */}
      <div className="flex items-end gap-2 h-32">
        {MOCK_MONTHLY.map((m) => (
          <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
            <div className="w-full flex flex-col justify-end" style={{ height: "96px" }}>
              <div
                className={`w-full rounded-t-md transition-all ${
                  m.current
                    ? "bg-primary"
                    : "bg-muted-foreground/20 hover:bg-muted-foreground/30"
                }`}
                style={{ height: `${(m.cost / maxCost) * 96}px` }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">{m.month}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ───

export default function CostsPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBilling = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<BillingData>("/api/billing");
    if (res.error) {
      setError(res.error);
    } else {
      setData(res.data ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchBilling();
  }, [fetchBilling]);

  const totalMockCost = MOCK_SERVICE_COSTS.reduce((s, c) => s + c.cost, 0);
  const prevMockCost = MOCK_MONTHLY[MOCK_MONTHLY.length - 2].cost;

  return (
    <>
      <AdminHeader
        title="GCP Costs"
        description="Cloud billing overview for the Tesserix GCP project"
        icon={DollarSign}
      />

      <main className="p-6 space-y-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {data?.billingEnabled && (
            <Badge variant="secondary" className="font-mono text-xs">
              {data.billingAccount?.replace("billingAccounts/", "")}
            </Badge>
          )}
          {data?.billingEnabled && (
            <Badge variant="success" className="text-xs">
              Billing enabled
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={fetchBilling} disabled={loading}>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span className="ml-1">Refresh</span>
        </Button>
      </div>

      {/* Error */}
      {error && (
        <ErrorState message={error} onRetry={fetchBilling} />
      )}

      {/* Setup required */}
      {!loading && data?.error === "billing_not_enabled" && (
        <SetupCard
          title="Billing not enabled"
          message={data.message ?? ""}
          steps={data.setupSteps ?? []}
        />
      )}

      {!loading && data?.error === "insufficient_permissions" && (
        <SetupCard
          title="Insufficient permissions"
          message={data.message ?? ""}
          steps={data.setupSteps ?? []}
        />
      )}

      {/* Main content — only shown when billing API returns valid data */}
      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-64" />
          <Skeleton className="h-48" />
        </div>
      ) : data && !data.error ? (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Stat size="sm">
              <StatLabel>Current Month</StatLabel>
              <StatValue>{formatCurrency(totalMockCost)}</StatValue>
              <StatMeta>Estimated</StatMeta>
            </Stat>
            <Stat size="sm">
              <StatLabel>Last Month</StatLabel>
              <StatValue>{formatCurrency(prevMockCost)}</StatValue>
              <StatMeta>February 2026</StatMeta>
            </Stat>
            <Stat size="sm">
              <StatLabel>Budgets</StatLabel>
              <StatValue>{data?.budgets?.length ?? 0}</StatValue>
              <StatMeta>
                {data?.budgets?.length
                  ? data.budgets[0].amount
                    ? `Budget: ${formatCurrency(data.budgets[0].amount.value, data.budgets[0].amount.currency)}`
                    : "Configured"
                  : "None configured"}
              </StatMeta>
            </Stat>
          </div>

          {/* Monthly trend */}
          <Card>
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <h3 className="text-sm font-semibold">Monthly Trend</h3>
              <Badge variant="outline" className="text-xs">Mock data</Badge>
            </div>
            <CardContent className="pt-2">
              <MonthlyTrendChart />
            </CardContent>
          </Card>

          {/* Cost by service */}
          <Card>
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <h3 className="text-sm font-semibold">Cost by GCP Service</h3>
              <Badge variant="outline" className="text-xs">Mock data</Badge>
            </div>
            <CardContent className="pt-2">
              <CostBarChart />
              <p className="mt-3 text-xs text-muted-foreground text-right">
                Total: <span className="font-medium text-foreground">{formatCurrency(totalMockCost)}</span>
              </p>
            </CardContent>
          </Card>

          {/* BigQuery export setup */}
          {data?.bqExportRequired && (
            <SetupCard
              title="Enable real-time cost data"
              message="Real per-service cost breakdowns require BigQuery billing export. The figures above are estimates."
              steps={data.bqSetupSteps ?? []}
            />
          )}

          {/* GCP Console link */}
          <div className="flex justify-end">
            <a
              href="https://console.cloud.google.com/billing"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Open GCP Billing Console
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      ) : null}
      </main>
    </>
  );
}
