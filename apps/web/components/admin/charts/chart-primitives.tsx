"use client";

import * as React from "react";
import type { LegendPayload, TooltipContentProps, TooltipPayloadEntry } from "recharts";
import { cn } from "@/lib/utils";
import { ChartSeries, defaultValueFormat } from "./chart-theme";

/**
 * Re-exported, trimmed view of a recharts tooltip payload entry — the fields the
 * kit's custom tooltips read. Consumers building their own tooltip can use this.
 */
export type ChartTooltipEntry = TooltipPayloadEntry;

/** recharts hands the Legend `content` render prop this shape. */
interface ChartLegendContentProps {
  payload?: ReadonlyArray<LegendPayload>;
}

function formatterFor(
  series: readonly ChartSeries[],
  dataKey: string | number | undefined,
): (value: number) => string {
  const match = series.find((s) => s.dataKey === dataKey);
  return match?.formatValue ?? defaultValueFormat;
}

function toNumber(value: unknown): number {
  if (Array.isArray(value)) return toNumber(value[0]);
  return typeof value === "number" ? value : Number(value);
}

/**
 * Themed tooltip. Pass `labelFormatter` to render the category/time label and
 * `series` so each row uses its own value formatter. Returns a render function
 * suitable for recharts' `<Tooltip content={...} />`.
 */
export function makeChartTooltip(opts: {
  series: readonly ChartSeries[];
  labelFormatter?: (label: string | number | undefined) => React.ReactNode;
}) {
  function ChartTooltip({ active, label, payload }: TooltipContentProps) {
    if (!active || !payload || payload.length === 0) return null;
    const heading = opts.labelFormatter ? opts.labelFormatter(label) : label;

    return (
      <div className="rounded-md border border-border bg-popover px-2.5 py-2 text-xs shadow-md">
        {heading != null && heading !== "" ? (
          <div className="mb-1 font-medium text-popover-foreground">{heading}</div>
        ) : null}
        <ul className="space-y-0.5">
          {payload.map((entry, i) => {
            const num = toNumber(entry.value);
            const dataKey = typeof entry.dataKey === "function" ? undefined : entry.dataKey;
            const fmt = formatterFor(opts.series, dataKey);
            return (
              <li
                key={`${String(dataKey ?? entry.name ?? i)}`}
                className="flex items-center justify-between gap-3"
              >
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: entry.color }}
                  />
                  {entry.name ?? dataKey}
                </span>
                <span className="font-medium tabular-nums text-popover-foreground">
                  {Number.isFinite(num) ? fmt(num) : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  return ChartTooltip;
}

/** Themed horizontal legend matching the design-system muted typography. */
export function ChartLegend({ payload }: ChartLegendContentProps) {
  if (!payload || payload.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground">
      {payload.map((entry, i) => (
        <li key={`${String(entry.dataKey ?? entry.value ?? i)}`} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
            style={{ backgroundColor: entry.color }}
          />
          {entry.value}
        </li>
      ))}
    </ul>
  );
}

/** Centered placeholder shown when a chart has no data. */
export function ChartEmpty({ message = "No data" }: { message?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}

/** Pulsing block used while data loads, sized to the chart area. */
export function ChartLoading({ className }: { className?: string }) {
  return (
    <div className={cn("h-full w-full animate-pulse rounded-md bg-muted/60", className)} aria-hidden="true" />
  );
}
