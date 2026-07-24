"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
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

export interface BarChartCardProps<T extends Record<string, unknown>> extends FrameProps {
  /** Row data; each object holds the category key plus one field per series. */
  data: readonly T[];
  /** Field used for the category (X) axis. */
  categoryKey: keyof T & string;
  /** One or more measures to plot as bars. */
  series: readonly ChartSeries[];
  /** Stack all series into a single bar instead of grouping side-by-side. */
  stacked?: boolean;
  /** Render bars horizontally (category on the Y axis). */
  layout?: "horizontal" | "vertical";
  /** Format the category axis tick / tooltip heading. */
  formatCategory?: (value: string | number) => string;
  /** Show the legend (default: on when more than one series). */
  showLegend?: boolean;
  /** Show the cartesian grid (default true). */
  showGrid?: boolean;
}

/** Categorical bar chart — grouped or stacked, vertical or horizontal. */
export function BarChartCard<T extends Record<string, unknown>>({
  data,
  categoryKey,
  series,
  stacked = false,
  layout = "horizontal",
  formatCategory,
  showLegend,
  showGrid = true,
  height = 280,
  ...frame
}: BarChartCardProps<T>) {
  const legend = showLegend ?? series.length > 1;
  const Tip = makeChartTooltip({
    series,
    labelFormatter: formatCategory ? (l) => formatCategory(l as string | number) : undefined,
  });
  const horizontal = layout === "horizontal";

  return (
    <ChartCard {...frame} height={height} isEmpty={data.length === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data as T[]}
          layout={layout}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          {showGrid ? (
            <CartesianGrid
              strokeOpacity={0.25}
              stroke={GRID_STROKE}
              vertical={!horizontal}
              horizontal={horizontal}
            />
          ) : null}
          {horizontal ? (
            <>
              <XAxis
                dataKey={categoryKey as DataKey<T>}
                tick={AXIS_TICK_STYLE}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatCategory ? (v) => formatCategory(v) : undefined}
              />
              <YAxis tick={AXIS_TICK_STYLE} tickLine={false} axisLine={false} width={44} />
            </>
          ) : (
            <>
              <XAxis type="number" tick={AXIS_TICK_STYLE} tickLine={false} axisLine={false} />
              <YAxis
                type="category"
                dataKey={categoryKey as DataKey<T>}
                tick={AXIS_TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={88}
                tickFormatter={formatCategory ? (v) => formatCategory(v) : undefined}
              />
            </>
          )}
          <Tooltip cursor={{ fillOpacity: 0.08 }} content={Tip} />
          {legend ? <Legend content={ChartLegend} /> : null}
          {series.map((s, i) => (
            <Bar
              key={s.dataKey}
              dataKey={s.dataKey}
              name={s.name ?? s.dataKey}
              fill={seriesColor(s, i)}
              stackId={stacked ? "stack" : undefined}
              radius={stacked ? 0 : [3, 3, 0, 0]}
              maxBarSize={48}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
