"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatRelativeTime, isStale } from "./format";

interface MetricsSectionProps {
  id: string;
  title: string;
  description?: string;
  lastRefreshedAt?: string;
  fixedWindowLabel?: string;
  error?: string;
  children: ReactNode;
}

export function MetricsSection({
  id,
  title,
  description,
  lastRefreshedAt,
  fixedWindowLabel,
  error,
  children,
}: MetricsSectionProps) {
  const stale = isStale(lastRefreshedAt);

  return (
    <section aria-labelledby={id} className="space-y-4">
      <header className="border-b border-border pb-2">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h2 id={id} className="text-base font-medium">
              {title}
            </h2>
            {fixedWindowLabel ? (
              <span className="text-xs text-muted-foreground">{fixedWindowLabel}</span>
            ) : null}
          </div>
          {lastRefreshedAt ? (
            <p
              className={cn(
                "text-xs tabular-nums",
                stale ? "text-amber-600" : "text-muted-foreground",
              )}
              title={stale ? "Data may be stale. Click Refresh to update." : undefined}
            >
              updated {formatRelativeTime(lastRefreshedAt)}
            </p>
          ) : null}
        </div>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </header>
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
          {error}
        </div>
      ) : (
        children
      )}
    </section>
  );
}
