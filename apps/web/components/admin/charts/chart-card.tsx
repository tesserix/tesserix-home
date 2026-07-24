"use client";

import * as React from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@tesserix/web";
import { cn } from "@/lib/utils";
import { ChartEmpty, ChartLoading } from "./chart-primitives";

export interface ChartCardProps {
  /** Card heading. */
  title: React.ReactNode;
  /** Optional sub-heading below the title. */
  description?: React.ReactNode;
  /** Slot rendered top-right (e.g. a range toggle or "view more" link). */
  action?: React.ReactNode;
  /** Pixel height of the chart plotting area (the ResponsiveContainer fills it). */
  height?: number;
  /** Show a loading placeholder instead of the chart. */
  loading?: boolean;
  /** Render the empty state instead of children. */
  isEmpty?: boolean;
  /** Message for the empty state. */
  emptyMessage?: string;
  /** Error string; when set, replaces the chart with an inline error panel. */
  error?: string | null;
  /** Extra classes on the outer Card. */
  className?: string;
  /** The chart — typically one of the *ChartCard bodies or a raw recharts tree. */
  children: React.ReactNode;
}

/**
 * Standard frame for every admin chart: design-system Card chrome, a fixed-height
 * plotting area, and built-in loading / empty / error states. Chart bodies stay
 * focused on their recharts tree and let this own the surrounding layout.
 */
export function ChartCard({
  title,
  description,
  action,
  height = 280,
  loading,
  isEmpty,
  emptyMessage,
  error,
  className,
  children,
}: ChartCardProps) {
  return (
    <Card className={cn("flex flex-col", className)}>
      {(title || description || action) && (
        <CardHeader>
          {title ? <CardTitle className="text-sm font-medium">{title}</CardTitle> : null}
          {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
          {action ? <CardAction>{action}</CardAction> : null}
        </CardHeader>
      )}
      <CardContent className="flex-1">
        <div style={{ height }} className="w-full">
          {error ? (
            <div className="flex h-full w-full items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-4 text-center text-xs text-destructive">
              {error}
            </div>
          ) : loading ? (
            <ChartLoading />
          ) : isEmpty ? (
            <ChartEmpty message={emptyMessage} />
          ) : (
            children
          )}
        </div>
      </CardContent>
    </Card>
  );
}
