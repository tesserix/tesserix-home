"use client";

// HomeChef admin CANCELLATION ARBITRATION queue (#475 / #480). Customer disputes
// and vendor timeouts land here; the admin picks the tier that matches what
// actually happened and the Go API issues the refund (timeout) or tops it up to
// the difference (dispute). The platform fee is never refundable and the admin can
// only RAISE a refund, never claw one back. Web twin of the HomeChef admin-portal
// + mobile-admin arbitration screens; the money seams live server-side.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatINR, formatDateTime, titleCase } from "@/lib/products/homechef/format";
import { useConfirm } from "@/components/admin/confirm-dialog";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import {
  CANCEL_REASONS,
  type AdminCancellationRequest,
  type CancelReasonValue,
} from "@/lib/products/homechef/contracts";

function statusTone(status: string): Tone {
  if (status === "disputed") return "danger";
  if (status === "admin_review") return "warning";
  if (status === "resolved") return "success";
  return "info";
}

function statusLabel(status: string): string {
  if (status === "admin_review") return "Vendor timeout";
  return titleCase(status);
}

/** paise → ₹ */
const money = (paise: number) => formatINR((paise ?? 0) / 100);

export default function HomechefCancellationsPage() {
  const { data, isLoading, mutate } = useSWR<{ data: AdminCancellationRequest[] }>(
    ["/cancel-requests", {}],
    swrFetcher,
    { refreshInterval: 30_000 },
  );
  const requests = data?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Cancellation arbitration</h1>
        <p className="text-sm text-muted-foreground">
          Customer disputes &amp; vendor timeouts. Pick the tier that matches what actually happened — the
          platform fee is never refundable, and you can only raise a refund (never claw back).
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing awaiting review.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {requests.map((r) => (
            <ArbitrationCard key={r.id} req={r} onResolved={() => mutate()} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArbitrationCard({
  req,
  onResolved,
}: {
  req: AdminCancellationRequest;
  onResolved: () => void;
}) {
  const { confirm } = useConfirm();
  const [reason, setReason] = useState<CancelReasonValue | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onResolve() {
    if (!reason) return;
    const tier = CANCEL_REASONS.find((t) => t.value === reason);
    const ok = await confirm({
      title: "Resolve cancellation",
      message: `Resolve order ${req.orderId.slice(0, 8)} as “${tier?.label}”. Any additional refund will be issued to the customer's wallet. The platform fee is never refundable and this can only raise the refund.`,
      confirmLabel: "Resolve",
    });
    if (!ok) return;
    setError(null);
    setBusy(true);
    try {
      await hcAdmin.post(`/cancel-requests/${req.id}/resolve`, {
        reason,
        note: note.trim() || undefined,
      });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resolve");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-background p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-sm text-foreground">Order {req.orderId.slice(0, 8)}</p>
        <StatusBadge label={statusLabel(req.status)} tone={statusTone(req.status)} />
      </div>

      {req.customerReason ? (
        <p className="mt-2 text-sm text-muted-foreground">Customer: “{req.customerReason}”</p>
      ) : null}
      {req.disputeReason ? (
        <p className="mt-0.5 text-sm italic text-muted-foreground">Dispute: “{req.disputeReason}”</p>
      ) : null}
      {req.refundExecuted ? (
        <p className="mt-1 text-xs tabular-nums text-muted-foreground">
          Already refunded {money(req.refundTotalPaise)} · vendor kept {money(req.vendorKeptPaise)}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(req.createdAt)}</p>

      <p className="mt-4 text-sm font-semibold text-foreground">Correct tier</p>
      <div className="mt-2 space-y-2">
        {CANCEL_REASONS.map((t) => {
          const active = reason === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setReason(t.value)}
              aria-pressed={active}
              className={`w-full rounded-lg border p-3 text-left transition-colors ${
                active ? "border-foreground bg-muted" : "border-border hover:bg-muted/50"
              }`}
            >
              <span className="block text-sm font-medium text-foreground">{t.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t.hint}</span>
            </button>
          );
        })}
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Internal note (optional)"
        rows={2}
        className="mt-3 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-foreground/20"
      />

      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}

      <button
        type="button"
        onClick={onResolve}
        disabled={!reason || busy}
        className="mt-3 w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background disabled:opacity-50"
      >
        {busy ? "Resolving…" : "Resolve"}
      </button>
    </div>
  );
}
