"use client";

import { useState } from "react";
import useSWR from "swr";

import {
  AnalyticsShell,
  BarChartCard,
  KpiCard,
  LineChartCard,
} from "@/components/admin/charts";

const REFRESH = 30_000;
const RANGES = ["1h", "24h", "7d"] as const;
type Range = (typeof RANGES)[number];

interface ByService extends Record<string, unknown> {
  service: string;
  requests: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
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
interface TraceRow {
  ts: string;
  service: string;
  span: string;
  durationMs: number;
  status: string;
}
interface ObsData {
  range: string;
  overview: { requests: number; errorRate: number; p95Ms: number; services: number };
  byService: ByService[];
  throughput: ThroughputRow[];
  latency: LatencyRow[];
  recentTraces: TraceRow[];
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`load failed (${r.status})`);
    return r.json() as Promise<ObsData>;
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
const isErr = (s: string) => /error/i.test(s);

export default function ObservabilityPage() {
  const [range, setRange] = useState<Range>("24h");
  const { data, error, isLoading, isValidating } = useSWR<ObsData>(
    `/api/admin/observability?range=${range}`,
    fetcher,
    { refreshInterval: REFRESH },
  );
  const d = data;
  const o = d?.overview;
  const errTone =
    (o?.errorRate ?? 0) >= 5 ? "critical" : (o?.errorRate ?? 0) >= 1 ? "warning" : "positive";

  const rangePicker = (
    <div className="flex gap-1 rounded-lg border border-border p-0.5">
      {RANGES.map((r) => (
        <button
          key={r}
          onClick={() => setRange(r)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${
            range === r
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );

  return (
    <AnalyticsShell
      title="Observability"
      description="Service health from OpenTelemetry traces · dedicated ClickHouse"
      live={isValidating ? "updating…" : true}
      filters={rangePicker}
    >
      {error ? (
        <AnalyticsShell.Section span="full">
          <p className="text-sm text-red-600 dark:text-red-400">
            Couldn&apos;t load observability data: {(error as Error).message}
          </p>
        </AnalyticsShell.Section>
      ) : (
        <>
          <AnalyticsShell.Section title="Overview" span="full">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <KpiCard label="Requests" value={fmtNum(o?.requests)} sub={`last ${range}`} />
              <KpiCard
                label="Error rate"
                value={o ? `${o.errorRate.toFixed(2)}%` : "—"}
                tone={errTone}
                badge={errTone === "critical" ? "High" : errTone === "warning" ? "Elevated" : "Healthy"}
              />
              <KpiCard label="p95 latency" value={fmtMs(o?.p95Ms)} sub="server spans" />
              <KpiCard label="Services" value={fmtNum(o?.services)} sub="emitting traces" />
            </div>
          </AnalyticsShell.Section>

          <AnalyticsShell.Section span="full">
            <LineChartCard
              title="Throughput"
              description={`Requests vs errors · last ${range}`}
              data={d?.throughput ?? []}
              xKey="t"
              formatX={fmtTime}
              loading={isLoading && !d}
              emptyMessage="No traces in this range yet."
              series={[
                { dataKey: "requests", name: "Requests" },
                { dataKey: "errors", name: "Errors", color: "var(--chart-3)" },
              ]}
            />
          </AnalyticsShell.Section>

          <AnalyticsShell.Section span="full">
            <LineChartCard
              title="Latency (server spans)"
              description={`p50 / p95 / p99 in ms · last ${range}`}
              data={d?.latency ?? []}
              xKey="t"
              formatX={fmtTime}
              loading={isLoading && !d}
              emptyMessage="No latency data yet."
              series={[
                { dataKey: "p50Ms", name: "p50" },
                { dataKey: "p95Ms", name: "p95" },
                { dataKey: "p99Ms", name: "p99" },
              ]}
            />
          </AnalyticsShell.Section>

          <AnalyticsShell.Section title="By service" span="full">
            <BarChartCard
              title="Requests by service"
              data={d?.byService ?? []}
              categoryKey="service"
              layout="horizontal"
              loading={isLoading && !d}
              emptyMessage="No services emitting yet."
              series={[{ dataKey: "requests", name: "Requests" }]}
            />
            <div className="mt-4 overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2.5">Service</th>
                    <th className="p-2.5 text-right">Requests</th>
                    <th className="p-2.5 text-right">Error rate</th>
                    <th className="p-2.5 text-right">p50</th>
                    <th className="p-2.5 text-right">p95</th>
                    <th className="p-2.5 text-right">p99</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(d?.byService ?? []).map((s) => (
                    <tr key={s.service}>
                      <td className="p-2.5 font-medium text-foreground">{s.service}</td>
                      <td className="p-2.5 text-right tabular-nums">{fmtNum(s.requests)}</td>
                      <td
                        className={`p-2.5 text-right tabular-nums ${
                          s.errorRate >= 5 ? "text-red-600 dark:text-red-400" : ""
                        }`}
                      >
                        {s.errorRate.toFixed(2)}%
                      </td>
                      <td className="p-2.5 text-right tabular-nums">{fmtMs(s.p50Ms)}</td>
                      <td className="p-2.5 text-right tabular-nums">{fmtMs(s.p95Ms)}</td>
                      <td className="p-2.5 text-right tabular-nums">{fmtMs(s.p99Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnalyticsShell.Section>

          <AnalyticsShell.Section title="Recent traces" span="full">
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2.5">Time</th>
                    <th className="p-2.5">Service</th>
                    <th className="p-2.5">Operation</th>
                    <th className="p-2.5 text-right">Duration</th>
                    <th className="p-2.5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(d?.recentTraces ?? []).map((tr, i) => (
                    <tr key={`${tr.ts}-${i}`}>
                      <td className="p-2.5 whitespace-nowrap text-muted-foreground">{fmtTime(tr.ts)}</td>
                      <td className="p-2.5 font-medium text-foreground">{tr.service}</td>
                      <td className="p-2.5 text-muted-foreground">{tr.span}</td>
                      <td className="p-2.5 text-right tabular-nums">{fmtMs(tr.durationMs)}</td>
                      <td className="p-2.5">
                        <span
                          className={
                            isErr(tr.status)
                              ? "text-red-600 dark:text-red-400"
                              : "text-green-600 dark:text-green-400"
                          }
                        >
                          {isErr(tr.status) ? "Error" : "OK"}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {(d?.recentTraces ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-4 text-center text-muted-foreground">
                        No traces in this range yet.
                      </td>
                    </tr>
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
