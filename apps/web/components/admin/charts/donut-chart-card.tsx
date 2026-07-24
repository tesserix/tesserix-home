"use client";

import * as React from "react";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { TooltipContentProps } from "recharts";
import { ChartCard, ChartCardProps } from "./chart-card";
import { chartColor, defaultValueFormat } from "./chart-theme";
import { ChartLegend } from "./chart-primitives";

type FrameProps = Omit<ChartCardProps, "children" | "isEmpty">;

/** A single slice of the donut. */
export interface DonutSlice {
  /** Slice label (legend + tooltip). */
  name: string;
  /** Numeric magnitude. */
  value: number;
  /** Explicit CSS color; defaults to a rotating palette slot. */
  color?: string;
}

export interface DonutChartCardProps extends FrameProps {
  /** Slices to render. */
  data: readonly DonutSlice[];
  /** Inner radius as a fraction of outer (0 = pie, default 0.6 = donut). */
  innerRadiusRatio?: number;
  /** Format a slice value for the tooltip and optional center total. */
  formatValue?: (value: number) => string;
  /** Show the legend (default true). */
  showLegend?: boolean;
  /** Center label content; if `true`, shows the formatted total. */
  centerLabel?: React.ReactNode | true;
  /** Small caption under the center label. */
  centerCaption?: React.ReactNode;
}

/** Donut / pie chart for share-of-total breakdowns. */
export function DonutChartCard({
  data,
  innerRadiusRatio = 0.6,
  formatValue = defaultValueFormat,
  showLegend = true,
  centerLabel,
  centerCaption,
  height = 280,
  ...frame
}: DonutChartCardProps) {
  const total = data.reduce((acc, d) => acc + (Number.isFinite(d.value) ? d.value : 0), 0);

  function DonutTooltip({ active, payload }: TooltipContentProps) {
    if (!active || !payload || payload.length === 0) return null;
    const entry = payload[0];
    if (!entry) return null;
    const raw = Array.isArray(entry.value) ? entry.value[0] : entry.value;
    const num = typeof raw === "number" ? raw : Number(raw);
    const pct = total > 0 && Number.isFinite(num) ? ` (${((num / total) * 100).toFixed(1)}%)` : "";
    return (
      <div className="rounded-md border border-border bg-popover px-2.5 py-2 text-xs shadow-md">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: entry.color }}
            />
            {entry.name}
          </span>
          <span className="font-medium tabular-nums text-popover-foreground">
            {Number.isFinite(num) ? formatValue(num) : "—"}
            {pct}
          </span>
        </div>
      </div>
    );
  }

  const centerNode = centerLabel === true ? formatValue(total) : centerLabel;

  return (
    <ChartCard {...frame} height={height} isEmpty={data.length === 0 || total === 0}>
      <div className="relative h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data as DonutSlice[]}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={`${Math.round(innerRadiusRatio * 70)}%`}
              outerRadius="70%"
              paddingAngle={data.length > 1 ? 1.5 : 0}
              isAnimationActive={false}
              stroke="var(--color-background, transparent)"
              strokeWidth={2}
            >
              {data.map((slice, i) => (
                <Cell key={slice.name} fill={slice.color ?? chartColor(i + 1)} />
              ))}
            </Pie>
            <Tooltip content={DonutTooltip} />
            {showLegend ? <Legend content={ChartLegend} /> : null}
          </PieChart>
        </ResponsiveContainer>
        {centerNode != null ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-lg font-semibold tabular-nums text-foreground">{centerNode}</span>
            {centerCaption ? (
              <span className="text-[11px] text-muted-foreground">{centerCaption}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </ChartCard>
  );
}
