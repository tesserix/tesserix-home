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
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";

export type Trend = "up" | "down" | "flat";

export interface StatTileProps {
  label: string;
  /** A `Money` is always minor units plus a currency — never a bare number. */
  value: string | number | Money;
  delta?: string;
  trend?: Trend;
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

/**
 * Props-shaped wrapper over `@tesserix/web`'s DashboardCard parts. `trend`
 * only colours the delta; it never invents a direction the caller did not
 * state, because "up" is not universally good.
 */
export function StatTile({ label, value, delta, trend, loading, href }: StatTileProps) {
  const TrendIcon = trend ? TREND_ICON[trend] : null;

  const card = (
    <DashboardCard className={href ? "transition-colors hover:border-ring" : undefined}>
      <DashboardCardHeader>
        <DashboardCardTitle>{label}</DashboardCardTitle>
      </DashboardCardHeader>
      {loading ? (
        <Skeleton className="h-8 w-24" aria-label={`${label} loading`} />
      ) : (
        <DashboardCardValue className="tabular-nums">{renderValue(value)}</DashboardCardValue>
      )}
      {!loading && delta ? (
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
