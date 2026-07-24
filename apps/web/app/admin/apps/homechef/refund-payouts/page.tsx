"use client";

// Fe3dr meal-plan refund payouts (v2 refund flow, RBI). The CUSTOMER chooses where an approved
// refund goes — wallet is instant (no admin step), the original method is a real Razorpay reversal.
// This queue holds only the refunds the customer routed to their ORIGINAL method; a Tesserix admin
// EXECUTES the gateway reversal here (RBI ~5-7 business days). The admin never picks the medium.
// The amount excludes the platform fee, GST, and delivery. Every action flows through the HMAC
// gateway to the Go API (escrow/ledger/NATS intact).

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, CreditCard } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";
import { formatCurrency } from "@/components/admin/metrics/format";

interface PendingRefundDay {
  dayId: string;
  date: string;
  slot: string;
  dishName: string;
  customerName: string;
  chefName: string;
  mealPlanNumber: string;
  chefChoice: string; // full | half
  refundAmount: number;
}

const GW = "/api/admin/apps/homechef/gw/meal-plan-days";

export default function HomechefRefundPayoutsPage() {
  const [rows, setRows] = useState<PendingRefundDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${GW}/pending-refunds`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data: PendingRefundDay[] };
      setRows(data.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Execute the customer-chosen ORIGINAL-method refund via Razorpay. The admin only runs it — the
  // medium is already decided (RBI), so there's no wallet/source choice to make here.
  async function execute(row: PendingRefundDay) {
    if (
      !window.confirm(
        `Execute a ${formatCurrency(row.refundAmount, "INR")} refund to ${
          row.customerName || "the customer"
        }'s original payment method (Razorpay, 5-7 business days)?\n\n${row.mealPlanNumber} · ${
          row.date
        } · ${row.dishName} (${row.chefChoice})`,
      )
    ) {
      return;
    }
    setBusyId(row.dayId);
    try {
      const res = await fetch(`${GW}/${row.dayId}/execute-refund`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      window.alert(`Failed to execute refund: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <AdminHeader
          title="Fe3dr · Refund payouts"
          description="Execute customer-chosen original-method meal-plan refunds via Razorpay"
        />
        <button
          onClick={() => void load()}
          className="mt-1 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Day</th>
              <th className="px-4 py-3">Plan / Customer</th>
              <th className="px-4 py-3">Chef · dish</th>
              <th className="px-4 py-3">Chef decision</th>
              <th className="px-4 py-3 text-right">Refund</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  No refunds awaiting execution.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.dayId} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.date}</div>
                    <div className="text-xs text-muted-foreground">{r.slot === "lunch" ? "Lunch" : "Dinner"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.customerName || "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.mealPlanNumber}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{r.chefName || "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.dishName || "—"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize">
                      {r.chefChoice}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {formatCurrency(r.refundAmount, "INR")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <button
                        disabled={busyId === r.dayId}
                        onClick={() => void execute(r)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
                      >
                        <CreditCard className="h-3.5 w-3.5" /> Execute refund
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        The customer already chose their original payment method (RBI). Executing reverses the charge
        to their card/UPI via Razorpay in ~5–7 business days. Wallet refunds are instant and never
        appear here. The refund excludes the platform fee, GST, and delivery.
      </p>
    </div>
  );
}
