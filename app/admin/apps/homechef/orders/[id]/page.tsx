"use client";

// HomeChef ORDER DETAIL. The full order behind a list row: line items, the money
// breakdown, refund state, and who the customer and chef are.
//
// Unlike the chefs page (which has no GET /admin/chefs/:id and expands from the
// list row), orders have a real detail endpoint — GET /admin/orders/:id — that
// preloads Items and flattens customer/chef. So this fetches.
//
// Read-only on purpose: refunds belong to the flows that own the money seams
// (Cancellations arbitration, Order issues), not to a generic detail screen —
// those enforce caps, the payout cross-guard and idempotency server-side. This
// links there instead of growing a second, unguarded refund button.

import { use } from "react";
import Link from "next/link";
import useSWR from "swr";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, formatINR, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import type { OrderDetailResponse } from "@/lib/products/homechef/contracts";

function statusTone(s: string): Tone {
  if (s === "delivered") return "success";
  if (s === "cancelled" || s === "rejected") return "danger";
  if (s === "pending") return "warning";
  return "info";
}

function paymentTone(s: string): Tone {
  if (s === "completed") return "success";
  if (s === "refunded" || s === "failed") return "danger";
  return "warning";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}

export default function HomechefOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading, error } = useSWR<OrderDetailResponse>(
    [`/orders/${id}`],
    swrFetcher,
  );

  if (isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading order…</p>;
  }
  if (error || !data) {
    return (
      <div className="space-y-3 p-6">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Order not found."}
        </p>
        <Link href="/admin/apps/homechef/orders" className="text-sm underline">
          Back to orders
        </Link>
      </div>
    );
  }

  const { order, customer, chef } = data;
  const items = order.items ?? [];
  const refunded = order.refundAmount > 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/admin/apps/homechef/orders"
            className="text-xs text-muted-foreground underline"
          >
            ← Orders
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold">
            {order.orderNumber}
            <StatusBadge tone={statusTone(order.status)} label={titleCase(order.status)} />
            <StatusBadge
              tone={paymentTone(order.paymentStatus)}
              label={titleCase(order.paymentStatus)}
            />
          </h1>
          <p className="text-sm text-muted-foreground">
            Placed {formatDateTime(order.createdAt)} · {titleCase(order.fulfillmentType)}
          </p>
        </div>
      </div>

      {/* Money first: it's what an admin opens an order for. */}
      <div className="rounded-lg border p-6">
        <h2 className="text-base font-semibold">Money</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="Subtotal" value={formatINR(order.subtotal)} />
          {order.serviceFee > 0 ? (
            <Fact label="Service fee" value={formatINR(order.serviceFee)} />
          ) : null}
          <Fact label="Delivery fee" value={formatINR(order.deliveryFee)} />
          <Fact label="Tax" value={formatINR(order.tax)} />
          {order.chefTip > 0 ? (
            <Fact label="Chef tip" value={formatINR(order.chefTip)} />
          ) : null}
          {order.driverTip > 0 ? (
            <Fact label="Driver tip" value={formatINR(order.driverTip)} />
          ) : null}
          {order.discount > 0 ? (
            <Fact
              label={order.promoCode ? `Discount (${order.promoCode})` : "Discount"}
              value={`−${formatINR(order.discount)}`}
            />
          ) : null}
          {order.walletApplied > 0 ? (
            <Fact label="Wallet applied" value={`−${formatINR(order.walletApplied)}`} />
          ) : null}
          <Fact label="Total" value={formatINR(order.total)} />
          <Fact label="Paid via" value={titleCase(order.paymentProvider || "—")} />
          <Fact label="Refunded" value={refunded ? formatINR(order.refundAmount) : "—"} />
          {refunded ? (
            <>
              <Fact label="Refund reason" value={order.refundReason || "—"} />
              <Fact
                label="Refund by"
                value={order.refundInitiatedBy ? titleCase(order.refundInitiatedBy) : "—"}
              />
            </>
          ) : null}
        </dl>

        {order.cancelledAt ? (
          <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
            Cancelled {formatDateTime(order.cancelledAt)}
            {order.cancelReason ? ` — ${order.cancelReason}` : ""}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border p-6">
          <h2 className="text-base font-semibold">Customer</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3">
            <Fact label="Name" value={customer.name || "—"} />
            <Fact label="Email" value={customer.email || "—"} />
            <Fact label="Phone" value={customer.phone || "—"} />
            <Fact label="Joined" value={formatDateTime(customer.createdAt)} />
          </dl>
          <Link
            href={`/admin/apps/homechef/users?search=${encodeURIComponent(customer.email ?? "")}`}
            className="mt-3 inline-block text-xs underline"
          >
            View customer
          </Link>
        </div>

        <div className="rounded-lg border p-6">
          <h2 className="text-base font-semibold">Chef</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3">
            <Fact label="Kitchen" value={chef.businessName || "—"} />
            <Fact label="City" value={chef.city || "—"} />
          </dl>
          <Link
            href={`/admin/apps/homechef/chefs?search=${encodeURIComponent(chef.businessName ?? "")}`}
            className="mt-3 inline-block text-xs underline"
          >
            View kitchen
          </Link>
        </div>
      </div>

      <div className="rounded-lg border p-6">
        <h2 className="text-base font-semibold">Items</h2>
        {items.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No line items on this order.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2">Item</th>
                <th className="py-2 text-right">Price</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b last:border-0">
                  <td className="py-2">{it.name}</td>
                  <td className="py-2 text-right tabular-nums">{formatINR(it.price)}</td>
                  <td className="py-2 text-right tabular-nums">{it.quantity}</td>
                  <td className="py-2 text-right tabular-nums">{formatINR(it.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Refunds live where their guards live. */}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/admin/apps/homechef/cancellations"
          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70"
        >
          Cancellation arbitration
        </Link>
        <Link
          href="/admin/apps/homechef/order-issues"
          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70"
        >
          Order issues
        </Link>
      </div>

      <p className="font-mono text-xs text-muted-foreground">{order.id}</p>
    </div>
  );
}
