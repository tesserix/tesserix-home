"use client";

import { Card, CardContent, Skeleton } from "@tesserix/web";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";

interface SparklinePoint {
  t: number;
  v: number;
}

interface SparklineCardProps {
  label: string;
  currentLabel: string;
  series: ReadonlyArray<SparklinePoint>;
  formatTooltipValue: (v: number) => string;
  zeroBaseline?: boolean;
  loading?: boolean;
}

export function SparklineCard({
  label,
  currentLabel,
  series,
  formatTooltipValue,
  zeroBaseline,
  loading,
}: SparklineCardProps) {
  const peak = series.reduce((acc, p) => (p.v > acc ? p.v : acc), 0);
  const peakAt = series.find((p) => p.v === peak);
  const peakTime = peakAt ? new Date(peakAt.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  const figcaption =
    series.length > 0
      ? `${label} over the last ${series.length} samples. Current ${currentLabel}. Peak ${formatTooltipValue(peak)}${peakTime ? ` at ${peakTime}` : ""}.`
      : `${label} — no data.`;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-sm font-semibold tabular-nums">{currentLabel}</p>
        </div>
        <figure className="mt-2">
          <figcaption className="sr-only">{figcaption}</figcaption>
          <div aria-hidden="true" className="h-20 w-full">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : series.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">—</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series.map((p) => ({ ...p }))} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  {zeroBaseline ? <YAxis hide={false} domain={[0, "dataMax"]} width={20} tick={false} axisLine={false} /> : null}
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="currentColor"
                    fillOpacity={0.15}
                    fill="currentColor"
                    strokeWidth={1.5}
                    isAnimationActive={false}
                    dot={false}
                  />
                  <Tooltip
                    cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const p = payload[0]!.payload as SparklinePoint;
                      const time = new Date(p.t).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      });
                      return (
                        <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md">
                          <div className="text-muted-foreground">{time}</div>
                          <div className="font-medium tabular-nums">{formatTooltipValue(p.v)}</div>
                        </div>
                      );
                    }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </figure>
      </CardContent>
    </Card>
  );
}
