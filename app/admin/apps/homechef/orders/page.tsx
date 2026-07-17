"use client";

import Link from "next/link";

// Fe3dr customer-ops: recent orders (read-only). Sourced from the Go /admin/orders
// API via the signed gateway — no direct homechef_db reads.
import { useState } from "react";
import useSWR from "swr";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatDate, formatINR, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import type { OrderRow, Paginated } from "@/lib/products/homechef/contracts";

const STATUSES = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "preparing", label: "Preparing" },
  { key: "out_for_delivery", label: "On the way" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

function statusTone(s: string): Tone {
  if (s === "delivered") return "success";
  if (s === "cancelled" || s === "refunded" || s === "rejected") return "danger";
  if (s === "pending") return "warning";
  return "info";
}

export default function HomechefOrdersPage() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useSWR<Paginated<OrderRow>>(
    ["/orders", { status, page, limit: 25 }],
    swrFetcher,
  );
  const rows = data?.data ?? [];
  const totalPages = data?.pagination.totalPages ?? 1;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Orders</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.total} orders` : "Customer-ops oversight"} · read-only
        </p>
      </div>

      <div className="flex gap-1">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => {
              setPage(1);
              setStatus(s.key);
            }}
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

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Customer → Chef</th>
              <th className="px-4 py-3">Items</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Placed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  No orders.
                </td>
              </tr>
            ) : (
              rows.map((o) => (
                <tr key={o.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link
                      href={`/admin/apps/homechef/orders/${o.id}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {o.orderNumber || o.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {o.customerName} <span className="text-muted-foreground">→</span> {o.chefName}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{o.itemCount}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatINR(o.total)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge label={titleCase(o.status)} tone={statusTone(o.status)} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">
                    {formatDate(o.createdAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{data?.pagination.total ?? 0} total</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
          >
            Prev
          </button>
          <span className="text-muted-foreground">
            Page {page} / {Math.max(1, totalPages)}
          </span>
          <button
            onClick={() => setPage((p) => (p < totalPages ? p + 1 : p))}
            disabled={page >= totalPages}
            className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
