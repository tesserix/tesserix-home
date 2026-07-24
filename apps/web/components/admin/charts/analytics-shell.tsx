"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface AnalyticsShellProps {
  /** Page title. */
  title: React.ReactNode;
  /** Optional sub-heading under the title. */
  description?: React.ReactNode;
  /**
   * When true, shows a pulsing "Live" indicator. When a string, the string is
   * used as the indicator label (e.g. "Streaming", "Paused"). Omit to hide it.
   */
  live?: boolean | string;
  /** Tone of the live indicator dot (default "live" = green). */
  liveTone?: "live" | "idle" | "stale";
  /** Filter controls rendered top-right (range pickers, selects, refresh, etc.). */
  filters?: React.ReactNode;
  /** Number of responsive grid columns at the `lg` breakpoint (default 2). */
  columns?: 1 | 2 | 3 | 4;
  /** Extra classes on the outer wrapper. */
  className?: string;
  /**
   * Section content. Use `<AnalyticsShell.Section>` children for the responsive
   * grid, or pass arbitrary nodes for full control.
   */
  children: React.ReactNode;
}

const TONE_DOT: Record<NonNullable<AnalyticsShellProps["liveTone"]>, string> = {
  live: "bg-emerald-500",
  idle: "bg-muted-foreground",
  stale: "bg-amber-500",
};

const COLS: Record<NonNullable<AnalyticsShellProps["columns"]>, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

function LiveIndicator({
  label,
  tone,
}: {
  label: string;
  tone: NonNullable<AnalyticsShellProps["liveTone"]>;
}) {
  const animate = tone === "live";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="relative flex h-2 w-2">
        {animate ? (
          <span
            className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", TONE_DOT[tone])}
            aria-hidden="true"
          />
        ) : null}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", TONE_DOT[tone])} aria-hidden="true" />
      </span>
      {label}
    </span>
  );
}

interface AnalyticsSectionProps {
  /** Optional section sub-title rendered above its grid items. */
  title?: React.ReactNode;
  /** Span n grid columns (e.g. a wide time-series above two donuts). */
  span?: 1 | 2 | 3 | 4 | "full";
  className?: string;
  children: React.ReactNode;
}

/** A grid cell within the AnalyticsShell section grid. */
function AnalyticsSection({ title, span = 1, className, children }: AnalyticsSectionProps) {
  const spanClass =
    span === "full"
      ? "col-span-full"
      : span === 2
        ? "lg:col-span-2"
        : span === 3
          ? "lg:col-span-3"
          : span === 4
            ? "lg:col-span-4"
            : "";
  return (
    <section className={cn(spanClass, className)}>
      {title ? <h3 className="mb-2 text-sm font-medium text-foreground">{title}</h3> : null}
      {children}
    </section>
  );
}

/**
 * Page-level frame for admin analytics views: a header row (title + description,
 * live indicator, and a filter slot) above a responsive section grid. Pair its
 * `AnalyticsShell.Section` children with the *ChartCard components.
 */
export function AnalyticsShell({
  title,
  description,
  live,
  liveTone = "live",
  filters,
  columns = 2,
  className,
  children,
}: AnalyticsShellProps) {
  const liveLabel = typeof live === "string" ? live : live ? "Live" : null;

  return (
    <div className={cn("space-y-6", className)}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            {liveLabel ? <LiveIndicator label={liveLabel} tone={liveTone} /> : null}
          </div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {filters ? <div className="flex flex-wrap items-center gap-2">{filters}</div> : null}
      </header>
      <div className={cn("grid grid-cols-1 gap-4", COLS[columns])}>{children}</div>
    </div>
  );
}

AnalyticsShell.Section = AnalyticsSection;
