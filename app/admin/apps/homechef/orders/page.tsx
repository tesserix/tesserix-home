"use client";

// Fe3dr customer-ops: recent orders + GMV summary (read-only). Direct
// homechef_db reads via the platform-admin role. 5B customer-ops oversight.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";

import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { formatCurrency, formatNumber } from "@/components/admin/metrics/format";

interface OrderRow {
  id: string;
  order_number: string;
  customer_name: string | null;
  chef_name: string | null;
  status: string;
  total: number;
  delivery_fee: number;
  currency: string;
  created_at: string;
}

interface OrdersResponse {
  data: OrderRow[];
  summary: { total_orders: number; gmv: number };
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const STATUS_OPTIONS = [
  "all", "pending", "accepted", "preparing", "ready",
  "picked_up", "delivering", "delivered", "cancelled", "refunded",
] as const;

function statusClass(s: string): string {
  if (s === "delivered") return "bg-emerald-500/15 text-emerald-700";
  if (s === "cancelled" || s === "refunded") return "bg-destructive/15 text-destructive";
  if (s === "pending") return "bg-amber-500/15 text-amber-700";
  return "bg-sky-500/15 text-sky-700";
}

export default function HomechefOrdersPage() {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [summary, setSummary] = useState<{ total_orders: number; gmv: number }>({ total_orders: 0, gmv: 0 });
  const [pagination, setPagination] = useState<OrdersResponse["pagination"]>({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [status, setStatus] = useState<string>("all");
  const [page, setPage] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (status !== "all") p.set("status", status);
      p.set("page", String(page));
      const res = await fetch(`/api/admin/apps/homechef/orders?${p.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OrdersResponse;
      setRows(data.data);
      setSummary(data.summary);
      setPagination(data.pagination);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, page]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Fe3dr · Orders" />
      <div className="flex-1 space-y-4 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile label="Orders (filter)" value={formatNumber(summary.total_orders)} hint="matching the current filter" loading={loading} />
          <KpiTile label="GMV (filter)" value={formatCurrency(summary.gmv, "INR")} hint="excl. cancelled/refunded" loading={loading} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Select value={status} onValueChange={(v) => { setPage(1); setStatus(v); }}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>{s === "all" ? "All statuses" : s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button onClick={() => void load()} className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent">
            <RefreshCw className={"h-3 w-3 " + (loading ? "animate-spin" : "")} /> Refresh
          </button>
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">Error: {error}</div>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Chef</th>
                <th className="px-3 py-2 text-right font-medium">Delivery</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Placed</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No orders.</td></tr>
              ) : (
                rows.map((o) => (
                  <tr key={o.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{o.order_number}</td>
                    <td className="px-3 py-2">{o.customer_name ?? "—"}</td>
                    <td className="px-3 py-2">{o.chef_name ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(o.delivery_fee, "INR")}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(o.total, "INR")}</td>
                    <td className="px-3 py-2">
                      <span className={"rounded-full px-2 py-0.5 text-xs capitalize " + statusClass(o.status)}>{o.status}</span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{o.created_at.slice(0, 10)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{pagination.total} order{pagination.total === 1 ? "" : "s"}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-md border border-border px-3 py-1 disabled:opacity-50">Prev</button>
            <span className="text-muted-foreground">Page {pagination.page} / {Math.max(1, pagination.totalPages)}</span>
            <button onClick={() => setPage((p) => (p < pagination.totalPages ? p + 1 : p))} disabled={page >= pagination.totalPages} className="rounded-md border border-border px-3 py-1 disabled:opacity-50">Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
