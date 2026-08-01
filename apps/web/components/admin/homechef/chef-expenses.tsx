"use client";

import { useState } from "react";
import useSWR from "swr";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatDate, formatINR } from "@tesserix/homechef-shared";

interface ChefExpenseRow {
  id: string;
  category: string;
  amount: number;
  note?: string;
  expenseDate: string;
  orderId?: string;
  orderNumber?: string;
  receiptUrl?: string;
  createdAt: string;
}

interface ChefExpensesResponse {
  chefId: string;
  businessName: string;
  expenses: ChefExpenseRow[];
  summary: {
    fyLabel: string;
    total: number;
    count: number;
    byCategory: { category: string; amount: number; count: number }[];
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  ingredients: "Ingredients",
  gas: "Gas / fuel",
  utensils: "Utensils",
  packaging: "Packaging",
  transport: "Transport",
  equipment: "Equipment",
  utilities: "Utilities",
  other: "Other",
};

function currentFyStartYear(d: Date = new Date()): number {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

function fyLabel(y: number): string {
  return `FY ${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

export function ChefExpensesPanel({ chefId }: { chefId: string }) {
  const [year, setYear] = useState(currentFyStartYear());
  const { data, isLoading, error } = useSWR<ChefExpensesResponse>(
    [`/chefs/${chefId}/expenses`, { year }],
    swrFetcher,
  );

  const years = [currentFyStartYear(), currentFyStartYear() - 1, currentFyStartYear() - 2];
  const expenses = data?.expenses ?? [];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Self-declared expenses
        </h3>
        <div className="flex gap-1">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => setYear(y)}
              className={`rounded-md px-2 py-1 text-xs font-medium ${
                year === y
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {fyLabel(y)}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-700 dark:text-red-300">Couldn&apos;t load expenses.</p>
      ) : expenses.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing recorded for {data?.summary.fyLabel ?? fyLabel(year)}.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              {data?.summary.count} entries · <strong className="text-foreground">{formatINR(data?.summary.total ?? 0)}</strong>
            </span>
            {data?.summary.byCategory.map((c) => (
              <span key={c.category} className="text-muted-foreground">
                {CATEGORY_LABELS[c.category] ?? c.category}: {formatINR(c.amount)}
              </span>
            ))}
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {expenses.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    {CATEGORY_LABELS[e.category] ?? e.category}
                    {e.orderNumber ? (
                      <span className="ml-1 text-xs text-muted-foreground">· #{e.orderNumber}</span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatDate(e.expenseDate)}
                    {e.note ? ` · ${e.note}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {e.receiptUrl ? (
                    <a
                      href={e.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium text-muted-foreground underline hover:text-foreground"
                    >
                      Receipt
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground/60">No receipt</span>
                  )}
                  <span className="text-sm font-medium tabular-nums text-foreground">
                    {formatINR(e.amount)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Receipt links are signed URLs valid for 15 minutes. Expenses are the chef&apos;s own
            books — they never affect settlement math.
          </p>
        </>
      )}
    </div>
  );
}
