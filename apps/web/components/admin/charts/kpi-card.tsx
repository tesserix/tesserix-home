"use client";

import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import { Badge, Card, CardContent } from "@tesserix/web";
import { cn } from "@/lib/utils";

/** Semantic tone driving the accent rail, value color, and badge variant. */
export type KpiTone = "neutral" | "positive" | "warning" | "critical" | "info";

const KPI_ACCENT: Record<KpiTone, string> = {
  neutral: "before:bg-border",
  positive: "before:bg-emerald-500",
  warning: "before:bg-amber-500",
  critical: "before:bg-red-500",
  info: "before:bg-sky-500",
};

const KPI_VALUE_COLOR: Record<KpiTone, string> = {
  neutral: "text-foreground",
  positive: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
};

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

const BADGE_FOR_TONE: Record<KpiTone, BadgeVariant> = {
  neutral: "neutral",
  positive: "success",
  warning: "warning",
  critical: "error",
  info: "info",
};

export interface KpiCardProps {
  /** Metric name shown above the value. */
  label: string;
  /** Pre-formatted metric value (already humanized — e.g. "₹1,23,456"). */
  value: string;
  /** Muted caption under the value. */
  sub?: string;
  /**
   * Delta string (e.g. "▲ 4.2% vs prev."). Colored green/red by `deltaUp`,
   * shown next to `sub`.
   */
  delta?: string;
  /** Whether the delta is an improvement (green) vs a regression (red). */
  deltaUp?: boolean;
  /** Drives the accent rail, value color, and badge variant. */
  tone?: KpiTone;
  /** Optional status pill (e.g. "High", "Healthy"). */
  badge?: string;
  /** Leading icon rendered top-right, muted. */
  icon?: LucideIcon;
  /** When set, the whole card links here and shows a "View" affordance. */
  href?: string;
  className?: string;
}

/**
 * A single headline metric tile: a left accent rail color-coded by tone, the
 * label / value / caption stack, an optional status badge or trend delta, and
 * an optional click-through link. Shared across the admin analytics surfaces so
 * KPI rows look identical everywhere.
 */
export function KpiCard({
  label,
  value,
  sub,
  delta,
  deltaUp,
  tone = "neutral",
  badge,
  icon: Icon,
  href,
  className,
}: KpiCardProps) {
  const card = (
    <Card
      className={cn(
        "relative overflow-hidden",
        // Left accent rail, color-coded by tone.
        "before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-['']",
        KPI_ACCENT[tone],
        href && "h-full transition-colors hover:border-foreground/30",
        className,
      )}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm text-muted-foreground">{label}</span>
          {badge ? (
            <Badge variant={BADGE_FOR_TONE[tone]} className="shrink-0">
              {badge}
            </Badge>
          ) : Icon ? (
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : null}
        </div>
        <div className={cn("mt-1 text-2xl font-semibold tabular-nums", KPI_VALUE_COLOR[tone])}>
          {value}
        </div>
        {sub || delta ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
            {sub ? <span className="text-muted-foreground">{sub}</span> : null}
            {delta ? (
              <span
                className={
                  deltaUp
                    ? "font-medium text-emerald-600 dark:text-emerald-400"
                    : "font-medium text-red-600 dark:text-red-400"
                }
              >
                {delta}
              </span>
            ) : null}
          </div>
        ) : null}
        {href ? (
          <div className="mt-3 flex items-center gap-1 text-xs font-medium text-foreground/80">
            View <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );

  return href ? (
    <Link href={href} className="block">
      {card}
    </Link>
  ) : (
    card
  );
}
