"use client";

import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tesserix/web";
import { formatCurrency } from "@/components/admin/metrics/format";
import { cn } from "@/lib/utils";

interface MarginCardProps {
  revenue: number;
  infraCost: number;
  margin: number;
  currency: string;
  inTrial?: boolean;
  productName: string;
}

export function MarginCard({
  revenue,
  infraCost,
  margin,
  currency,
  inTrial,
  productName,
}: MarginCardProps) {
  // Negative margin → red primary value (loss-making). Positive stays neutral
  // — adequacy depends on growth context, not absolute sign. Trial → muted
  // since revenue is 0 by definition.
  const isNegative = margin < 0;
  const valueClass = inTrial
    ? "text-muted-foreground"
    : isNegative
      ? "text-rose-600"
      : "text-foreground";

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <p className={cn("text-3xl font-semibold tabular-nums", valueClass)}>
          {inTrial ? "—" : formatCurrency(margin, currency)}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="How is margin calculated?">
              <Info className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            Estimated margin = subscription revenue − infrastructure cost proxy.
            Revenue is the tenant&apos;s plan price for the window. Infra cost is
            the {productName} namespace cost allocated by activity share
            (50% requests, 30% storage, 20% egress). It is a model, not a
            measurement.
          </TooltipContent>
        </Tooltip>
      </div>
      {inTrial ? (
        <p className="text-xs text-muted-foreground">
          Trial — margin not applicable until the subscription converts.
        </p>
      ) : null}
      <dl className="grid grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Revenue</dt>
          <dd className="tabular-nums">{formatCurrency(revenue, currency)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Infra cost</dt>
          <dd className="tabular-nums">{formatCurrency(infraCost, currency)}</dd>
        </div>
        <div className="flex items-center justify-between font-medium">
          <dt className="text-muted-foreground">Margin</dt>
          <dd className={cn("tabular-nums", valueClass)}>
            {inTrial ? "—" : formatCurrency(margin, currency)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
