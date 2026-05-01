"use client";

import Link from "next/link";
import { ArrowUpRight, ArrowDown, ArrowUp } from "lucide-react";
import { PlanBadge } from "./plan-badge";
import { StatusBadge } from "./status-badge";
import { DunningPill } from "./dunning-pill";
import { formatCurrency, formatNumber } from "@/components/admin/metrics/format";
import { cn } from "@/lib/utils";

export interface SubscriptionRowItem {
  tenantId: string;
  tenantName: string;
  plan: string;
  status: string;
  mrr: number;
  currency: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialDaysRemaining?: number | null;
  conversionLikelihood?: "low" | "medium" | "high";
  dunningState?: "retrying" | "exhausted" | null;
}

export type SortKey = "tenantName" | "plan" | "status" | "mrr" | "currentPeriodEnd";
export type SortDir = "asc" | "desc";

interface SubscriptionsTableProps {
  rows: ReadonlyArray<SubscriptionRowItem>;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  productId: string;
}

interface ColSpec {
  key: SortKey | "dunning" | "trial";
  label: string;
  sortable: boolean;
  align?: "right";
}

const COLUMNS: ReadonlyArray<ColSpec> = [
  { key: "tenantName", label: "Tenant", sortable: true },
  { key: "plan", label: "Plan", sortable: true },
  { key: "status", label: "Status", sortable: true },
  { key: "mrr", label: "MRR", sortable: true, align: "right" },
  { key: "currentPeriodEnd", label: "Renews", sortable: true },
  { key: "trial", label: "Trial", sortable: false },
  { key: "dunning", label: "Dunning", sortable: false },
];

function ariaSortFor(col: ColSpec, sortKey: SortKey, sortDir: SortDir): "ascending" | "descending" | "none" {
  if (!col.sortable || col.key !== sortKey) return "none";
  return sortDir === "asc" ? "ascending" : "descending";
}

export function SubscriptionsTable({ rows, sortKey, sortDir, onSort, productId }: SubscriptionsTableProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No subscriptions match this filter.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                aria-sort={c.sortable ? ariaSortFor(c, sortKey, sortDir) : undefined}
                className={cn("px-4 py-3", c.align === "right" && "text-right")}
              >
                {c.sortable ? (
                  <button
                    type="button"
                    onClick={() => onSort(c.key as SortKey)}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    {c.label}
                    {sortKey === c.key ? (
                      sortDir === "asc" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : null}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tenantId} className="border-b border-border last:border-0 hover:bg-muted/30">
              <td className="px-4 py-3 font-medium">{r.tenantName}</td>
              <td className="px-4 py-3">
                <PlanBadge plan={r.plan} />
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={r.status} />
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {r.mrr === 0 ? "—" : formatCurrency(r.mrr, r.currency)}
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                {r.currentPeriodEnd ? new Date(r.currentPeriodEnd).toLocaleDateString() : "—"}
                {r.cancelAtPeriodEnd ? <span className="ml-1 text-amber-700">(cancels)</span> : null}
              </td>
              <td className="px-4 py-3 text-xs">
                {r.trialDaysRemaining != null ? (
                  <span>
                    {formatNumber(r.trialDaysRemaining)}d left
                    {r.conversionLikelihood ? (
                      <span className="ml-1 capitalize text-muted-foreground">
                        · {r.conversionLikelihood}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                <DunningPill state={r.dunningState ?? null} />
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/admin/apps/${productId}/tenants/${r.tenantId}`}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Open <ArrowUpRight className="h-3 w-3" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
