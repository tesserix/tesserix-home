"use client";

// HomeChef admin DELIVERY-FAILURE RESOLUTION queue (#613 / epic #403). Surfaces every
// unresolved delivery failure across the three order shapes — pending `delivery_failed`
// OrderIssues (gateway + chef self-delivery), `failed` meal-plan days, and `failed` group
// orders — and lets an admin confirm a fault, which runs the money policy via the Go
// resolve-delivery-failure endpoints. Read-only listing; the money seams live server-side.
//
// Hybrid policy the admin confirms per row (owner-decided): CUSTOMER fault → the chef is
// paid, the customer is NOT refunded (delivery fee retained); PLATFORM/CHEF fault → the
// customer is fully refunded and the chef payout is blocked. Money only actually moves when
// the escrow flags are live; until then the resolution advances the DB hold state only.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatINR, titleCase } from "@/lib/products/homechef/format";
import { useConfirm } from "@/components/admin/confirm-dialog";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import type {
  DeliveryFailuresResponse,
  DeliveryFaultClass,
  PayoutHoldStatus,
} from "@/lib/products/homechef/contracts";

function holdTone(status: PayoutHoldStatus): Tone {
  switch (status) {
    case "release_eligible":
      return "success";
    case "released":
      return "info";
    case "awaiting_customer_confirmation":
    case "withheld":
      return "warning";
    case "reversed":
    case "disputed":
      return "danger";
    default:
      return "neutral";
  }
}

const FAULTS: { fault: DeliveryFaultClass; label: string; tone: "neutral" | "destructive" }[] = [
  { fault: "customer", label: "Customer fault", tone: "neutral" },
  { fault: "platform", label: "Platform fault", tone: "destructive" },
  { fault: "chef", label: "Chef fault", tone: "destructive" },
];

function faultOutcome(fault: DeliveryFaultClass): string {
  return fault === "customer"
    ? "the chef is PAID and the customer is NOT refunded (delivery fee retained)"
    : "the customer is FULLY refunded and the chef payout is blocked";
}

export default function HomechefDeliveryFailuresPage() {
  const { data, isLoading, mutate } = useSWR<DeliveryFailuresResponse>(
    ["/delivery-failures", {}],
    swrFetcher,
  );
  const { confirm } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const orders = data?.orderIssues ?? [];
  const days = data?.mealPlanDays ?? [];
  const groups = data?.groupOrders ?? [];
  const total = orders.length + days.length + groups.length;

  async function resolve(
    id: string,
    context: string,
    amount: number,
    path: string,
    fault: DeliveryFaultClass,
  ) {
    const ok = await confirm({
      title: `${titleCase(fault)} fault — ${context}`,
      message: `Confirm ${fault.toUpperCase()} fault for ${context} (${formatINR(amount)}): ${faultOutcome(fault)}. This runs the money policy when escrow is live.`,
      confirmLabel: `Confirm ${fault} fault`,
      tone: fault === "customer" ? undefined : "destructive",
    });
    if (!ok) return;
    setError(null);
    setBusyId(id);
    try {
      await hcAdmin.post(path, { fault });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolution failed");
    } finally {
      setBusyId(null);
    }
  }

  function FaultButtons({
    id,
    context,
    amount,
    path,
    suggested,
  }: {
    id: string;
    context: string;
    amount: number;
    path: string;
    suggested?: string;
  }) {
    const busy = busyId === id;
    return (
      <div className="flex flex-wrap justify-end gap-1">
        {FAULTS.map(({ fault, label }) => (
          <button
            key={fault}
            onClick={() => resolve(id, context, amount, path, fault)}
            disabled={busy}
            title={suggested === fault ? "Suggested by the reported reason" : undefined}
            className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
              suggested === fault
                ? "bg-foreground text-background"
                : "border border-border text-foreground hover:bg-muted"
            }`}
          >
            {busy ? "…" : label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Delivery failures</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${total} awaiting resolution` : "Confirm fault on failed deliveries"} · money moves
          only when escrow is live
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : total === 0 ? (
        <p className="rounded-lg border border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No delivery failures awaiting resolution.
        </p>
      ) : (
        <>
          {/* Orders (gateway + chef self-delivery) */}
          {orders.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">
                Orders <span className="text-muted-foreground">({orders.length})</span>
              </h2>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Order</th>
                      <th className="px-4 py-3">Reason</th>
                      <th className="px-4 py-3">Reported by</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Hold</th>
                      <th className="px-4 py-3 text-right">Resolve fault</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {orders.map((o) => (
                      <tr key={o.issueId} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium text-foreground">
                          {o.orderNumber || o.orderId.slice(0, 8)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{titleCase(o.reason || "—")}</td>
                        <td className="px-4 py-3 text-muted-foreground">{titleCase(o.reportedBy || "—")}</td>
                        <td className="px-4 py-3 tabular-nums">{formatINR(o.total)}</td>
                        <td className="px-4 py-3">
                          <StatusBadge label={titleCase(o.holdStatus)} tone={holdTone(o.holdStatus)} />
                        </td>
                        <td className="px-4 py-3">
                          <FaultButtons
                            id={o.issueId}
                            context={`order ${o.orderNumber || o.orderId.slice(0, 8)}`}
                            amount={o.total}
                            path={`/order-issues/${o.issueId}/resolve-delivery-failure`}
                            suggested={o.suggestedFault}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Meal-plan (tiffin) days */}
          {days.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">
                Tiffin days <span className="text-muted-foreground">({days.length})</span>
              </h2>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Hold</th>
                      <th className="px-4 py-3 text-right">Resolve fault</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {days.map((d) => (
                      <tr key={d.dayId} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium text-foreground">
                          {d.mealPlanNumber || d.mealPlanId.slice(0, 8)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {d.date ? new Date(d.date).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-3 tabular-nums">{formatINR(d.price)}</td>
                        <td className="px-4 py-3">
                          <StatusBadge label={titleCase(d.holdStatus)} tone={holdTone(d.holdStatus)} />
                        </td>
                        <td className="px-4 py-3">
                          <FaultButtons
                            id={d.dayId}
                            context={`tiffin day ${d.mealPlanNumber || d.mealPlanId.slice(0, 8)}`}
                            amount={d.price}
                            path={`/meal-plan-days/${d.dayId}/resolve-delivery-failure`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Group orders */}
          {groups.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">
                Group orders <span className="text-muted-foreground">({groups.length})</span>
              </h2>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Group</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Hold</th>
                      <th className="px-4 py-3 text-right">Resolve fault</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {groups.map((g) => (
                      <tr key={g.groupId} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium text-foreground">GRP-{g.groupId.slice(0, 8)}</td>
                        <td className="px-4 py-3 tabular-nums">{formatINR(g.subtotal + g.tax)}</td>
                        <td className="px-4 py-3">
                          <StatusBadge label={titleCase(g.holdStatus)} tone={holdTone(g.holdStatus)} />
                        </td>
                        <td className="px-4 py-3">
                          <FaultButtons
                            id={g.groupId}
                            context={`group GRP-${g.groupId.slice(0, 8)}`}
                            amount={g.subtotal + g.tax}
                            path={`/group-orders/${g.groupId}/resolve-delivery-failure`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
