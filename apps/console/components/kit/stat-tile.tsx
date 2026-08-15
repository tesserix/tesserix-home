// See page-header.tsx: @tesserix/web's barrel is "use client", so its exports
// are `undefined` inside a server component. This directive is load-bearing
// even though nothing here uses a hook.
"use client";

import Link from "next/link";
import {
  DashboardCard,
  DashboardCardHeader,
  DashboardCardTitle,
  DashboardCardTrend,
  DashboardCardValue,
  Skeleton,
} from "@tesserix/web";
import { formatMoney, type Money } from "@tesserix/console-core";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  PlugZap,
  TriangleAlert,
} from "lucide-react";
import { INSTRUMENTATION_UNAVAILABLE_MESSAGE, type SurfaceState } from "./states";

export type Trend = "up" | "down" | "flat";

export interface StatTileProps {
  label: string;
  /** A `Money` is always minor units plus a currency — never a bare number. */
  value: string | number | Money;
  delta?: string;
  trend?: Trend;
  /**
   * The tile's surface state, same five kinds as its siblings. A stat tile is
   * exactly where a parked observability endpoint's number lands, so it must
   * be able to say "we are not measuring this" instead of skeletoning forever
   * or coercing a 501 through `String(value)`.
   *
   * `empty` and `filtered-empty` are folded into an em-dash reading rather
   * than a full EmptyState: a single number has nothing to illustrate.
   */
  state?: SurfaceState;
  /** @deprecated Pass `state={{ kind: "loading" }}`. Kept so existing callers keep working. */
  loading?: boolean;
  href?: string;
}

function isMoney(value: StatTileProps["value"]): value is Money {
  return typeof value === "object" && value !== null && "minor" in value && "currency" in value;
}

function renderValue(value: StatTileProps["value"]): string {
  if (isMoney(value)) {
    return formatMoney(value);
  }
  return String(value);
}

const TREND_ICON = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: ArrowRight,
} as const;

const TREND_TONE = {
  up: "text-success",
  down: "text-destructive",
  flat: "text-muted-foreground",
} as const;

/** A tile is small: the non-ready states get one compact line, not a panel. */
const COMPACT_NOTE_CLASS = "mt-1 flex items-start gap-1.5 text-xs leading-snug";

/**
 * Props-shaped wrapper over `@tesserix/web`'s DashboardCard parts. `trend`
 * only colours the delta; it never invents a direction the caller did not
 * state, because "up" is not universally good.
 */
export function StatTile({ label, value, delta, trend, state, loading, href }: StatTileProps) {
  const TrendIcon = trend ? TREND_ICON[trend] : null;
  const resolved: SurfaceState = state ?? (loading ? { kind: "loading" } : { kind: "ready" });
  const parked = resolved.kind === "instrumentation-unavailable";

  const card = (
    <DashboardCard
      // `tone` is the design system's own compact warning treatment. It is
      // deliberately not the full `Callout` the table uses: a tile has room
      // for one line, and a panel inside a stat grid reads as a broken layout.
      tone={parked ? "warning" : resolved.kind === "error" ? "critical" : undefined}
      className={href ? "transition-colors hover:border-ring" : undefined}
    >
      <DashboardCardHeader>
        <DashboardCardTitle>{label}</DashboardCardTitle>
      </DashboardCardHeader>

      {resolved.kind === "loading" ? (
        <Skeleton className="h-8 w-24" aria-label={`${label} loading`} />
      ) : parked ? (
        // Distinct from both empty ("—", nothing to show) and error ("could
        // not load, retrying might help"): this number is not being measured.
        <div role="status" className={COMPACT_NOTE_CLASS}>
          <PlugZap className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">Not measured</span>
            <span className="sr-only">{` — ${INSTRUMENTATION_UNAVAILABLE_MESSAGE}`}</span>
          </span>
        </div>
      ) : resolved.kind === "error" ? (
        <div role="alert" className={`${COMPACT_NOTE_CLASS} text-destructive`}>
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{resolved.message}</span>
        </div>
      ) : resolved.kind === "ready" ? (
        <DashboardCardValue className="tabular-nums">{renderValue(value)}</DashboardCardValue>
      ) : (
        // empty / filtered-empty: there is simply no number to show.
        <DashboardCardValue className="tabular-nums text-muted-foreground">
          <span aria-hidden="true">—</span>
          <span className="sr-only">No data</span>
        </DashboardCardValue>
      )}

      {resolved.kind === "ready" && delta ? (
        <DashboardCardTrend
          className={`inline-flex items-center gap-1 ${trend ? TREND_TONE[trend] : ""}`}
        >
          {TrendIcon ? <TrendIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
          {delta}
        </DashboardCardTrend>
      ) : null}
    </DashboardCard>
  );

  if (!href) {
    return card;
  }

  return (
    <Link href={href} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
      {card}
    </Link>
  );
}
