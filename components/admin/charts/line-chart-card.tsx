"use client";

import * as React from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
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

export interface LineChartCardProps<T extends Record<string, unknown>> extends FrameProps {
  /** Time-ordered rows; each holds the x key plus one field per series. */
  data: readonly T[];
  /** Field for the X axis — typically a timestamp (ms epoch) or ISO string. */
  xKey: keyof T & string;
  /** One or more measures to plot as lines. */
  series: readonly ChartSeries[];
  /** Format an X tick. Defaults to a short date/time for numeric/ISO inputs. */
  formatX?: (value: string | number) => string;
  /** Curve interpolation (default "monotone"). */
  curve?: "monotone" | "linear" | "step" | "natural";
  /** Render point markers (default false for dense time-series). */
  showDots?: boolean;
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

/** Time-series line chart with one line per series. */
export function LineChartCard<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  formatX = defaultTimeFormat,
  curve = "monotone",
  showDots = false,
  showLegend,
  showGrid = true,
  height = 280,
  ...frame
}: LineChartCardProps<T>) {
  const legend = showLegend ?? series.length > 1;
  const Tip = makeChartTooltip({
    series,
    labelFormatter: (l) => formatX(l as string | number),
  });

  return (
    <ChartCard {...frame} height={height} isEmpty={data.length === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data as T[]} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
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
            <Line
              key={s.dataKey}
              type={curve}
              dataKey={s.dataKey}
              name={s.name ?? s.dataKey}
              stroke={seriesColor(s, i)}
              strokeWidth={2}
              dot={showDots ? { r: 2.5 } : false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
