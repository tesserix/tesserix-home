"use client";

// Easy Split operator surface (Home-Chef-App #1085). Two questions, one screen:
// which chefs can be split-paid right now, and for the orders already paid,
// which rail settled them and does the amount agree. Deltas are listed as rows,
// never summarised into a tick — the row is what an operator acts on.

import { useState } from "react";
import useSWR from "swr";
import { RefreshCw } from "lucide-react";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { StatusBadge } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";

interface RosterChef {
  chefId: string;
  businessName: string;
  mode: string;
  vendorId: string;
  vendorStatus: string;
  easySplitMode: string;
  effective: boolean;
  payable: boolean;
  blocker: string;
  splitOrders: number;
  splitPaise: number;
}

interface RosterResponse {
  globalEnabled: boolean;
  windowFits: boolean;
  platformFeeMinor: number;
  feeReadable: boolean;
  days: number;
  chefs: RosterChef[];
}

interface SettlementOrder {
  orderId: string;
  orderNumber: string;
  chefId: string;
  chefName: string;
  status: string;
  createdAt: string;
  totalPaise: number;
  expectedPaise: number;
  splitPaise: number;
  deltaPaise: number;
  rail: string;
  reason: string;
  exception: boolean;
}

interface OrdersResponse {
  days: number;
  orders: SettlementOrder[];
  summary: {
    splitCount: number;
    splitPaise: number;
    payoutCount: number;
    exceptionCount: number;
    deltaPaise: number;
  };
}

// Plain-language names for the reason constants the Go release path records.
const BLOCKER_COPY: Record<string, string> = {
  not_enabled_for_chef: "Not enabled",
  vendor_not_active: "Vendor not verified",
  fssai_expired: "FSSAI lapsed",
  platform_fee_unreadable: "Fee setting unreadable",
  credit_funded: "Paid with credit",
  share_below_fee: "Share below fee",
  no_order: "No order",
};

const RAIL_FILTERS = ["all", "split", "payout", "exception"] as const;
type RailFilter = (typeof RAIL_FILTERS)[number];

function blockerLabel(reason: string): string {
  return BLOCKER_COPY[reason] ?? reason.replace(/_/g, " ");
}

function rupees(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  });
}

export function EasySplitPanel() {
  const [days, setDays] = useState(7);
  const [rail, setRail] = useState<RailFilter>("all");
  const [query, setQuery] = useState("");
  const [busyChef, setBusyChef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  const roster = useSWR<RosterResponse>(
    ["/payouts/easy-split/roster", { days, query: query.trim() || undefined }],
    swrFetcher,
  );
  const ledger = useSWR<OrdersResponse>(
    ["/payouts/easy-split/orders", { days, rail: rail === "all" ? undefined : rail }],
    swrFetcher,
  );

  async function setMode(chef: RosterChef, value: string) {
    if (value === "on" && !chef.payable && chef.blocker !== "not_enabled_for_chef") {
      const ok = await confirm({
        title: `Force Easy Split on for ${chef.businessName}?`,
        message: `${blockerLabel(chef.blocker)} still blocks this chef, so their orders will keep settling through the weekly statement path until it is cleared. Turning the switch on now only decides what happens once it is.`,
        confirmLabel: "Turn on anyway",
      });
      if (!ok) return;
    }
    setBusyChef(chef.chefId);
    setError(null);
    try {
      await hcAdmin.put(`/chefs/${chef.chefId}/easy-split-mode`, { value });
      await roster.mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusyChef(null);
    }
  }

  const summary = ledger.data?.summary;

  return (
    <section className="space-y-4 rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Easy Split</h3>
          <StatusBadge
            tone={roster.data?.globalEnabled ? "success" : "neutral"}
            label={roster.data?.globalEnabled ? "Platform flag on" : "Platform flag off"}
          />
          {roster.data && !roster.data.windowFits ? (
            <StatusBadge tone="danger" label="Maturation window exceeds split delay" />
          ) : null}
          {roster.data && !roster.data.feeReadable ? (
            <StatusBadge tone="danger" label="Fee unreadable — splits paused" />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Window
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="h-8 rounded-md border border-border bg-background px-2"
              aria-label="Reporting window in days"
            >
              <option value={1}>24 hours</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          <button
            onClick={() => {
              void roster.mutate();
              void ledger.mutate();
            }}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs hover:bg-accent"
          >
            <RefreshCw
              className={
                "h-3 w-3 " + (roster.isValidating || ledger.isValidating ? "animate-spin" : "")
              }
            />
            Refresh
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The chef&apos;s net share is allocated when the release governor clears
        the order, not at capture — so holds, blocks and the maturation window
        all get their say first. Anything the rail refuses settles through the
        weekly statement path instead, which is where every order was before
        Easy Split existed.
      </p>

      {/* Vendor roster */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-medium uppercase text-muted-foreground">
            Vendor roster
          </h4>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by kitchen name"
            className="h-8 w-56 rounded-md border border-border bg-background px-2 text-xs"
            aria-label="Filter roster by kitchen name"
          />
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Kitchen</th>
                <th className="px-3 py-2 font-medium">Vendor</th>
                <th className="px-3 py-2 font-medium">Split-payable</th>
                <th className="px-3 py-2 text-right font-medium">Orders split</th>
                <th className="px-3 py-2 text-right font-medium">Split value</th>
                <th className="px-3 py-2 font-medium">Rollout</th>
              </tr>
            </thead>
            <tbody>
              {(roster.data?.chefs ?? []).map((chef) => (
                <tr key={chef.chefId} className="border-t border-border">
                  <td className="px-3 py-2">{chef.businessName || chef.chefId.slice(0, 8)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {chef.vendorStatus || "not registered"}
                  </td>
                  <td className="px-3 py-2">
                    {chef.payable ? (
                      <StatusBadge tone="success" label="Yes" />
                    ) : (
                      <StatusBadge tone="warning" label={blockerLabel(chef.blocker)} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{chef.splitOrders}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {rupees(chef.splitPaise)}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={chef.easySplitMode || ""}
                      disabled={busyChef === chef.chefId}
                      onChange={(e) => void setMode(chef, e.target.value)}
                      className="h-8 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
                      aria-label={`Easy Split rollout for ${chef.businessName}`}
                    >
                      <option value="">
                        Inherit ({roster.data?.globalEnabled ? "on" : "off"})
                      </option>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                  </td>
                </tr>
              ))}
              {roster.data && roster.data.chefs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                    No kitchens match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* Settlement ledger / reconciliation */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-medium uppercase text-muted-foreground">
            Settlement by order
          </h4>
          <div className="flex items-center gap-1">
            {RAIL_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setRail(f)}
                className={
                  "rounded-md px-2.5 py-1 text-xs capitalize " +
                  (rail === f ? "bg-foreground text-background" : "border border-border hover:bg-accent")
                }
              >
                {f}
                {f === "exception" && summary?.exceptionCount
                  ? ` (${summary.exceptionCount})`
                  : ""}
              </button>
            ))}
          </div>
        </div>

        {summary ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {summary.splitCount} split · {rupees(summary.splitPaise)} paid from capture ·{" "}
            {summary.payoutCount} on the statement path · {summary.exceptionCount} to review ·
            net delta {rupees(summary.deltaPaise)}
          </p>
        ) : null}

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Kitchen</th>
                <th className="px-3 py-2 font-medium">Rail</th>
                <th className="px-3 py-2 text-right font-medium">Expected</th>
                <th className="px-3 py-2 text-right font-medium">Split</th>
                <th className="px-3 py-2 text-right font-medium">Delta</th>
                <th className="px-3 py-2 font-medium">Why not split</th>
              </tr>
            </thead>
            <tbody>
              {(ledger.data?.orders ?? []).map((order) => (
                <tr
                  key={order.orderId}
                  className={"border-t border-border " + (order.exception ? "bg-destructive/5" : "")}
                >
                  <td className="px-3 py-2 tabular-nums">{order.orderNumber}</td>
                  <td className="px-3 py-2">{order.chefName || order.chefId.slice(0, 8)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge
                      tone={order.rail === "split" ? "success" : "neutral"}
                      label={order.rail === "split" ? "Split" : "Statement"}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {rupees(order.expectedPaise)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {order.splitPaise ? rupees(order.splitPaise) : "—"}
                  </td>
                  <td
                    className={
                      "px-3 py-2 text-right tabular-nums " +
                      (order.deltaPaise ? "text-destructive" : "text-muted-foreground")
                    }
                  >
                    {order.deltaPaise ? rupees(order.deltaPaise) : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {order.rail === "split"
                      ? "—"
                      : order.reason
                        ? blockerLabel(order.reason)
                        : "No reason recorded"}
                  </td>
                </tr>
              ))}
              {ledger.data && ledger.data.orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    {rail === "exception"
                      ? "Nothing to review in this window."
                      : "No paid orders in this window."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Expected is the chef&apos;s net share less the flat platform fee; Split
          is what the gateway confirmed and we stamped on the order. A delta
          means those two disagree — it is not a comparison against
          Cashfree&apos;s settlement file.
        </p>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
