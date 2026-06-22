"use client";

import { useState } from "react";
import useSWR from "swr";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatDate, formatINR, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import type { MealPlanRow, Paginated } from "@/lib/products/homechef/contracts";

const STATUSES = [
  { key: "", label: "All" },
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "cancelled", label: "Cancelled" },
];

function tone(status: string): Tone {
  if (status === "active") return "success";
  if (status === "cancelled") return "danger";
  if (status === "paused") return "warning";
  return "neutral";
}

export default function HomechefMealPlansPage() {
  const [status, setStatus] = useState("");
  const { data, isLoading } = useSWR<Paginated<MealPlanRow>>(
    ["/meal-plans", { status, page: 1, limit: 50 }],
    swrFetcher,
  );
  const plans = data?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Meal Plans</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.total} subscriptions` : "Subscription oversight"} · read-only
        </p>
      </div>

      <div className="flex gap-1">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => setStatus(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              status === s.key
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Window</th>
              <th className="px-4 py-3">Cadence</th>
              <th className="px-4 py-3">Total</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : plans.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  No meal plans.
                </td>
              </tr>
            ) : (
              plans.map((p) => (
                <tr key={p.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium text-foreground">{p.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {p.startDate
                      ? `${formatDate(p.startDate)} → ${p.endDate ? formatDate(p.endDate) : "ongoing"}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {p.daysPerWeek ? `${p.daysPerWeek} days/wk · ` : ""}
                    {p.mealCount ?? 0} meals
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {p.totalPrice != null ? formatINR(p.totalPrice) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge label={titleCase(p.status)} tone={tone(p.status)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
