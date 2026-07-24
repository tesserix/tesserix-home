"use client";

import { Fragment, useState } from "react";
import useSWR from "swr";

import {
  AnalyticsShell,
  DonutChartCard,
  KpiCard,
  LineChartCard,
} from "@/components/admin/charts";

const REFRESH = 30_000;
const RANGES = ["1h", "24h", "7d"] as const;
const APPS = [
  { key: "", label: "All apps" },
  { key: "mark8ly", label: "Mark8ly" },
  { key: "fe3dr", label: "fe3dr · HomeChef" },
  { key: "platform", label: "Platform" },
  { key: "devai", label: "DevAI" },
] as const;
const APP_LABEL: Record<string, string> = {
  mark8ly: "Mark8ly",
  fe3dr: "fe3dr · HomeChef",
  platform: "Platform",
  devai: "DevAI",
  other: "Other",
};

interface AppRow extends Record<string, unknown> {
  app: string;
  requests: number;
  errorRate: number;
  p95Ms: number;
  services: number;
}
interface SvcRow {
  service: string;
  app: string;
  requests: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}
interface OpRow {
  service: string;
  op: string;
  count: number;
  p95Ms?: number;
  errors?: number;
}
interface TraceRow {
  traceId: string;
  service: string;
  app: string;
  op: string;
  durationMs: number;
  status: string;
  ts: string;
}
interface ThroughputRow extends Record<string, unknown> {
  t: string;
  requests: number;
  errors: number;
}
interface LatencyRow extends Record<string, unknown> {
  t: string;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}
interface ObsData {
  overview: { requests: number; errorRate: number; p95Ms: number; services: number };
  byApp: AppRow[];
  throughput: ThroughputRow[];
  latency: LatencyRow[];
  statusDist: { status: string; count: number }[];
  topSlow: OpRow[];
  topErrors: OpRow[];
  byService: SvcRow[];
  recentTraces: TraceRow[];
}
interface SpanRow {
  spanId: string;
  parentId: string;
  service: string;
  op: string;
  kind: string;
  startNs: number;
  durationNs: number;
  status: string;
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`load failed (${r.status})`);
    return r.json();
  });

const fmtNum = (n: number | undefined) =>
  (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtMs = (n: number | undefined) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(0)} ms`;
const fmtTime = (v: string | number) => {
  const d = new Date(typeof v === "string" ? v.replace(" ", "T") : v);
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const toneFor = (rate: number) => (rate >= 5 ? "critical" : rate >= 1 ? "warning" : "positive");

function Pills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { key: T; label: string }[] | readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  const opts = options.map((o) =>
    typeof o === "string" ? { key: o, label: o } : o,
  );
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border border-border p-0.5">
      {opts.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${
            value === o.key
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TraceWaterfall({ traceId }: { traceId: string }) {
  const { data, isLoading } = useSWR<{ spans: SpanRow[] }>(
    `/api/admin/observability/trace?id=${traceId}`,
    fetcher,
  );
  const spans = data?.spans ?? [];
  if (isLoading) return <p className="p-3 text-sm text-muted-foreground">Loading spans…</p>;
  if (spans.length === 0) return <p className="p-3 text-sm text-muted-foreground">No spans.</p>;
  const t0 = Math.min(...spans.map((s) => Number(s.startNs)));
  const t1 = Math.max(...spans.map((s) => Number(s.startNs) + Number(s.durationNs)));
  const total = Math.max(t1 - t0, 1);
  return (
    <div className="space-y-1 bg-muted/20 p-3">
      <div className="mb-1 text-xs text-muted-foreground">
        {spans.length} spans · {fmtMs(total / 1e6)} total
      </div>
      {spans.map((s) => {
        const left = ((Number(s.startNs) - t0) / total) * 100;
        const width = Math.max((Number(s.durationNs) / total) * 100, 0.5);
        return (
          <div key={s.spanId} className="flex items-center gap-2 text-xs">
            <div className="w-56 shrink-0 truncate" title={`${s.service} · ${s.op}`}>
              <span className="text-foreground">{s.op}</span>{" "}
              <span className="text-muted-foreground">· {s.service}</span>
            </div>
            <div className="relative h-3 flex-1 rounded bg-muted">
              <div
                className={`absolute h-3 rounded ${
                  s.status === "Error" ? "bg-red-500" : "bg-foreground"
                }`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={fmtMs(Number(s.durationNs) / 1e6)}
              />
            </div>
            <div className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
              {fmtMs(Number(s.durationNs) / 1e6)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ObservabilityPage() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const [app, setApp] = useState<string>("");
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const { data, error, isLoading, isValidating } = useSWR<ObsData>(
    `/api/admin/observability?range=${range}&app=${app}`,
    fetcher,
    { refreshInterval: REFRESH },
  );
  const d = data;
  const o = d?.overview;

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <Pills options={APPS} value={app} onChange={setApp} />
      <Pills options={RANGES} value={range} onChange={setRange} />
    </div>
  );

  return (
    <AnalyticsShell
      title="Observability"
      description="Distributed traces from OpenTelemetry · all products · dedicated ClickHouse"
      live={isValidating ? "updating…" : true}
      filters={filters}
    >
      {error ? (
        <AnalyticsShell.Section span="full">
          <p className="text-sm text-red-600 dark:text-red-400">
            Couldn&apos;t load observability data: {(error as Error).message}
          </p>
        </AnalyticsShell.Section>
      ) : (
        <>
          {/* Per-app health cards */}
          <AnalyticsShell.Section title="By application" span="full">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {(d?.byApp ?? []).map((a) => (
                <button key={a.app} onClick={() => setApp(a.app === app ? "" : a.app)} className="text-left">
                  <KpiCard
                    label={APP_LABEL[a.app] ?? a.app}
                    value={fmtNum(a.requests)}
                    sub={`${a.services} svc · p95 ${fmtMs(a.p95Ms)}`}
                    tone={toneFor(a.errorRate)}
                    badge={`${a.errorRate.toFixed(1)}% err`}
                  />
                </button>
              ))}
              {(d?.byApp ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">No traces yet.</p>
              )}
            </div>
          </AnalyticsShell.Section>

          {/* Overview KPIs (respecting the app filter) */}
          <AnalyticsShell.Section title={app ? `${APP_LABEL[app] ?? app} · overview` : "Overview"} span="full">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <KpiCard label="Traces" value={fmtNum(o?.requests)} sub={`last ${range}`} />
              <KpiCard
                label="Error rate"
                value={o ? `${o.errorRate.toFixed(2)}%` : "—"}
                tone={toneFor(o?.errorRate ?? 0)}
              />
              <KpiCard label="p95 latency" value={fmtMs(o?.p95Ms)} />
              <KpiCard label="Services" value={fmtNum(o?.services)} sub="emitting" />
            </div>
          </AnalyticsShell.Section>

          <AnalyticsShell.Section span="full">
            <LineChartCard
              title="Throughput"
              description={`Traces vs errors · last ${range}`}
              data={d?.throughput ?? []}
              xKey="t"
              formatX={fmtTime}
              loading={isLoading && !d}
              emptyMessage="No traces in this range."
              series={[
                { dataKey: "requests", name: "Traces" },
                { dataKey: "errors", name: "Errors", color: "var(--chart-3)" },
              ]}
            />
          </AnalyticsShell.Section>

          <AnalyticsShell.Section span="full">
            <LineChartCard
              title="Latency"
              description={`p50 / p95 / p99 ms · last ${range}`}
              data={d?.latency ?? []}
              xKey="t"
              formatX={fmtTime}
              loading={isLoading && !d}
              emptyMessage="No latency data."
              series={[
                { dataKey: "p50Ms", name: "p50" },
                { dataKey: "p95Ms", name: "p95" },
                { dataKey: "p99Ms", name: "p99" },
              ]}
            />
          </AnalyticsShell.Section>

          {/* Status donut + top slow ops */}
          <div className="grid gap-4 lg:grid-cols-2">
            <DonutChartCard
              title="Trace status"
              data={(d?.statusDist ?? []).map((s) => ({
                name: s.status,
                value: s.count,
                color: s.status === "Error" ? "var(--chart-3)" : "var(--chart-2)",
              }))}
              loading={isLoading && !d}
              emptyMessage="No traces."
            />
            <div className="rounded-lg border border-border p-4">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Slowest operations (p95)</h3>
              <div className="space-y-1.5 text-sm">
                {(d?.topSlow ?? []).map((op) => (
                  <div key={`${op.service}-${op.op}`} className="flex items-center justify-between gap-2">
                    <span className="truncate" title={`${op.service} · ${op.op}`}>
                      <span className="text-foreground">{op.op}</span>{" "}
                      <span className="text-xs text-muted-foreground">· {op.service}</span>
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">{fmtMs(op.p95Ms)}</span>
                  </div>
                ))}
                {(d?.topSlow ?? []).length === 0 && (
                  <p className="text-muted-foreground">No operations.</p>
                )}
              </div>
            </div>
          </div>

          {/* Top errors (only when present) */}
          {(d?.topErrors ?? []).length > 0 && (
            <AnalyticsShell.Section title="Top errors" span="full">
              <div className="rounded-lg border border-border p-4">
                <div className="space-y-1.5 text-sm">
                  {d!.topErrors.map((op) => (
                    <div key={`${op.service}-${op.op}`} className="flex items-center justify-between gap-2">
                      <span className="truncate" title={`${op.service} · ${op.op}`}>
                        <span className="text-foreground">{op.op}</span>{" "}
                        <span className="text-xs text-muted-foreground">· {op.service}</span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums text-red-600 dark:text-red-400">
                        {fmtNum(op.errors)} / {fmtNum(op.count)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </AnalyticsShell.Section>
          )}

          {/* Per-service table */}
          <AnalyticsShell.Section title="Services" span="full">
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2.5">Service</th>
                    <th className="p-2.5">App</th>
                    <th className="p-2.5 text-right">Traces</th>
                    <th className="p-2.5 text-right">Errors</th>
                    <th className="p-2.5 text-right">p50</th>
                    <th className="p-2.5 text-right">p95</th>
                    <th className="p-2.5 text-right">p99</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(d?.byService ?? []).map((s) => (
                    <tr key={s.service}>
                      <td className="p-2.5 font-medium text-foreground">{s.service}</td>
                      <td className="p-2.5 text-muted-foreground">{APP_LABEL[s.app] ?? s.app}</td>
                      <td className="p-2.5 text-right tabular-nums">{fmtNum(s.requests)}</td>
                      <td className={`p-2.5 text-right tabular-nums ${s.errorRate >= 5 ? "text-red-600 dark:text-red-400" : ""}`}>
                        {s.errorRate.toFixed(2)}%
                      </td>
                      <td className="p-2.5 text-right tabular-nums">{fmtMs(s.p50Ms)}</td>
                      <td className="p-2.5 text-right tabular-nums">{fmtMs(s.p95Ms)}</td>
                      <td className="p-2.5 text-right tabular-nums">{fmtMs(s.p99Ms)}</td>
                    </tr>
                  ))}
                  {(d?.byService ?? []).length === 0 && (
                    <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">No services.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </AnalyticsShell.Section>

          {/* Trace explorer with waterfall drill-down */}
          <AnalyticsShell.Section title="Trace explorer" span="full">
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2.5">Time</th>
                    <th className="p-2.5">App</th>
                    <th className="p-2.5">Service</th>
                    <th className="p-2.5">Root operation</th>
                    <th className="p-2.5 text-right">Duration</th>
                    <th className="p-2.5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(d?.recentTraces ?? []).map((tr) => (
                    <Fragment key={tr.traceId}>
                      <tr
                        onClick={() => setOpenTrace(openTrace === tr.traceId ? null : tr.traceId)}
                        className="cursor-pointer hover:bg-muted/30"
                      >
                        <td className="p-2.5 whitespace-nowrap text-muted-foreground">{fmtTime(tr.ts)}</td>
                        <td className="p-2.5 text-muted-foreground">{APP_LABEL[tr.app] ?? tr.app}</td>
                        <td className="p-2.5 font-medium text-foreground">{tr.service}</td>
                        <td className="p-2.5 text-muted-foreground">{tr.op}</td>
                        <td className="p-2.5 text-right tabular-nums">{fmtMs(tr.durationMs)}</td>
                        <td className="p-2.5">
                          <span className={tr.status === "Error" ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}>
                            {tr.status}
                          </span>
                        </td>
                      </tr>
                      {openTrace === tr.traceId && (
                        <tr>
                          <td colSpan={6} className="p-0">
                            <TraceWaterfall traceId={tr.traceId} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {(d?.recentTraces ?? []).length === 0 && (
                    <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No traces in this range.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </AnalyticsShell.Section>
        </>
      )}
    </AnalyticsShell>
  );
}
