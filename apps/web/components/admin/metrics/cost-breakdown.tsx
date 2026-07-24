"use client";

import { formatCurrency } from "./format";

interface BreakdownEntry {
  label: string;
  value: number;
  color: string;
}

interface CostBreakdownStackProps {
  total: number;
  currency: string;
  breakdown: ReadonlyArray<BreakdownEntry>;
}

export function CostBreakdownStack({ total, currency, breakdown }: CostBreakdownStackProps) {
  const sum = breakdown.reduce((acc, b) => acc + b.value, 0) || 1;

  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {breakdown.map((b) => {
          const pct = (b.value / sum) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={b.label}
              className={b.color}
              style={{ width: `${pct}%` }}
              title={`${b.label} — ${formatCurrency(b.value, currency)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3 lg:grid-cols-5">
        {breakdown.map((b) => {
          const pct = total > 0 ? (b.value / total) * 100 : 0;
          return (
            <div key={b.label} className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${b.color}`} aria-hidden="true" />
              <dt className="text-muted-foreground">{b.label}</dt>
              <dd className="ml-auto tabular-nums">{formatCurrency(b.value, currency)}</dd>
              <dd className="w-10 text-right tabular-nums text-muted-foreground">{pct.toFixed(0)}%</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
