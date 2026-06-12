"use client";

// Home Chef chef-payout admin. Lists all chefs' weekly settlement statements
// (homechef_db, direct) with filters, a CSV export, and a mark-paid action that
// records a manual disbursement reference. Statement calculation is automated in
// homechef-api; disbursement is manual (RazorpayX automation gated on an Indian
// entity). 5B / Wave 7E.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Download, CheckCircle2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";

import { AdminHeader } from "@/components/admin/header";
import { formatCurrency, formatNumber } from "@/components/admin/metrics/format";

interface StatementRow {
  id: string;
  chef_id: string;
  chef_name: string | null;
  week_start: string;
  week_end: string;
  currency: string;
  orders_count: number;
  gross_revenue: number;
  platform_commission: number;
  cgst: number;
  sgst: number;
  igst: number;
  tds: number;
  net_payout: number;
  status: string;
  paid_at: string | null;
  payout_ref: string | null;
}

interface ListResponse {
  data: StatementRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const STATUS_OPTIONS = ["all", "pending", "paid"] as const;

export default function HomechefPayoutsPage() {
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [pagination, setPagination] = useState<ListResponse["pagination"]>({
    page: 1, limit: 20, total: 0, totalPages: 0,
  });
  const [status, setStatus] = useState<string>("all");
  const [week, setWeek] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const queryString = useCallback(() => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (week) p.set("week", week);
    p.set("page", String(page));
    return p.toString();
  }, [status, week, page]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/apps/homechef/payouts?${queryString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ListResponse;
      setRows(data.data);
      setPagination(data.pagination);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => { void load(); }, [load]);

  async function markPaid(row: StatementRow) {
    const ref = window.prompt(
      `Mark ${row.chef_name ?? row.chef_id}'s ${row.week_start.slice(0, 10)} statement as PAID.\nEnter the payout reference (UTR / RazorpayX id / bank ref):`,
    );
    if (!ref || !ref.trim()) return;
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/admin/apps/homechef/payouts/${row.id}/mark-paid`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payoutRef: ref.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      window.alert(`Failed to mark paid: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  const inr = (n: number) => formatCurrency(n, "INR");

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Home Chef · Payouts" />
      <div className="flex-1 space-y-4 p-6">
        <p className="text-sm text-muted-foreground">
          Weekly chef settlement statements. Calculation is automated; disbursement is manual —
          send the transfer, then record its reference here.
        </p>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <Select value={status} onValueChange={(v) => { setPage(1); setStatus(v); }}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>{s === "all" ? "All statuses" : s}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <input
            type="date"
            value={week}
            onChange={(e) => { setPage(1); setWeek(e.target.value); }}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            aria-label="Week starting"
          />

          <button
            onClick={() => void load()}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent"
          >
            <RefreshCw className={"h-3 w-3 " + (loading ? "animate-spin" : "")} /> Refresh
          </button>

          <a
            href={`/api/admin/apps/homechef/payouts/export?${queryString().replace(/&?page=\d+/, "")}`}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent"
          >
            <Download className="h-3 w-3" /> Export CSV
          </a>
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Error: {error}
          </div>
        ) : null}

        {/* Table */}
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Chef</th>
                <th className="px-3 py-2 font-medium">Week</th>
                <th className="px-3 py-2 text-right font-medium">Orders</th>
                <th className="px-3 py-2 text-right font-medium">Gross</th>
                <th className="px-3 py-2 text-right font-medium">Commission</th>
                <th className="px-3 py-2 text-right font-medium">GST</th>
                <th className="px-3 py-2 text-right font-medium">TDS</th>
                <th className="px-3 py-2 text-right font-medium">Net payout</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">No statements.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2">{r.chef_name ?? r.chef_id.slice(0, 8)}</td>
                    <td className="px-3 py-2 tabular-nums">{r.week_start.slice(0, 10)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.orders_count)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(r.gross_revenue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(r.platform_commission)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(r.cgst + r.sgst + r.igst)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(r.tds)}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{inr(r.net_payout)}</td>
                    <td className="px-3 py-2">
                      <span className={
                        "rounded-full px-2 py-0.5 text-xs capitalize " +
                        (r.status === "paid"
                          ? "bg-emerald-500/15 text-emerald-700"
                          : "bg-amber-500/15 text-amber-700")
                      }>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "paid" ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={r.payout_ref ?? ""}>
                          <CheckCircle2 className="h-3 w-3 text-emerald-600" /> {r.payout_ref?.slice(0, 16) ?? "paid"}
                        </span>
                      ) : (
                        <button
                          onClick={() => void markPaid(r)}
                          disabled={busyId === r.id}
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                        >
                          {busyId === r.id ? "Saving…" : "Mark paid"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {pagination.total} statement{pagination.total === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
            >
              Prev
            </button>
            <span className="text-muted-foreground">
              Page {pagination.page} / {Math.max(1, pagination.totalPages)}
            </span>
            <button
              onClick={() => setPage((p) => (p < pagination.totalPages ? p + 1 : p))}
              disabled={page >= pagination.totalPages}
              className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
