"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DataKey } from "recharts";
import { ChartCard, ChartCardProps } from "./chart-card";
import {
  AXIS_TICK_STYLE,
  ChartSeries,
  GRID_STROKE,
  seriesColor,
} from "./chart-theme";
import { ChartLegend, makeChartTooltip } from "./chart-primitives";

type FrameProps = Omit<ChartCardProps, "children" | "isEmpty">;

export interface AreaChartCardProps<T extends Record<string, unknown>> extends FrameProps {
  /** Time-ordered rows; each holds the x key plus one field per series. */
  data: readonly T[];
  /** Field for the X axis — typically a timestamp or ISO string. */
  xKey: keyof T & string;
  /** One or more measures to plot as filled areas. */
  series: readonly ChartSeries[];
  /** Stack areas (default true — area charts usually show composition). */
  stacked?: boolean;
  /** Curve interpolation (default "monotone"). */
  curve?: "monotone" | "linear" | "step" | "natural";
  /** Fill opacity for the area body (default 0.18). */
  fillOpacity?: number;
  /** Format an X tick. */
  formatX?: (value: string | number) => string;
  /** Show the legend (default: on when more than one series). */
  showLegend?: boolean;
  /** Show the cartesian grid (default true). */
  showGrid?: boolean;
}

function defaultTimeFormat(value: string | number): string {
  const d = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Filled area chart — good for cumulative or composition-over-time views. */
export function AreaChartCard<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  stacked = true,
  curve = "monotone",
  fillOpacity = 0.18,
  formatX = defaultTimeFormat,
  showLegend,
  showGrid = true,
  height = 280,
  ...frame
}: AreaChartCardProps<T>) {
  const legend = showLegend ?? series.length > 1;
  const Tip = makeChartTooltip({
    series,
    labelFormatter: (l) => formatX(l as string | number),
  });
  const gradientId = React.useId();

  return (
    <ChartCard {...frame} height={height} isEmpty={data.length === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data as T[]} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            {series.map((s, i) => {
              const color = seriesColor(s, i);
              const id = `${gradientId}-${i}`;
              return (
                <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={fillOpacity * 2} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              );
            })}
          </defs>
          {showGrid ? (
            <CartesianGrid strokeOpacity={0.25} stroke={GRID_STROKE} vertical={false} />
          ) : null}
          <XAxis
            dataKey={xKey as DataKey<T>}
            tick={AXIS_TICK_STYLE}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tickFormatter={(v) => formatX(v)}
          />
          <YAxis tick={AXIS_TICK_STYLE} tickLine={false} axisLine={false} width={44} />
          <Tooltip cursor={{ stroke: GRID_STROKE, strokeOpacity: 0.4 }} content={Tip} />
          {legend ? <Legend content={ChartLegend} /> : null}
          {series.map((s, i) => (
            <Area
              key={s.dataKey}
              type={curve}
              dataKey={s.dataKey}
              name={s.name ?? s.dataKey}
              stroke={seriesColor(s, i)}
              strokeWidth={2}
              fill={`url(#${gradientId}-${i})`}
              stackId={stacked ? "stack" : undefined}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
