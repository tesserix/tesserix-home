"use client";

import Link from "next/link";
import {
  Card,
  CardContent,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@tesserix/web";
import { cn } from "@/lib/utils";

interface KpiTileProps {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  ariaValueText?: string;
  icon?: React.ComponentType<{ className?: string }>;
  loading?: boolean;
  dataSource?: string;
  lastRefreshedAt?: string;
}

export function KpiTile({
  label,
  value,
  hint,
  href,
  ariaValueText,
  icon: Icon,
  loading,
  dataSource,
  lastRefreshedAt,
}: KpiTileProps) {
  const tip = dataSource && lastRefreshedAt ? `${dataSource} · refreshed ${lastRefreshedAt}` : undefined;

  const inner = (
    <Card className={cn("transition-colors", href && "hover:border-foreground/30")}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          {Icon ? <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : null}
        </div>
        <div className="mt-2">
          {loading ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <span className="text-2xl font-semibold tabular-nums" aria-label={ariaValueText}>
              {value}
            </span>
          )}
        </div>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );

  const wrapped = tip ? (
    <Tooltip>
      <TooltipTrigger asChild>{href ? <Link href={href}>{inner}</Link> : <div>{inner}</div>}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  ) : href ? (
    <Link href={href}>{inner}</Link>
  ) : (
    inner
  );

  return wrapped;
}
