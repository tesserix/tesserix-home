"use client";

// The Cashfree disbursement queue. A batch is born from a statement (Prepare),
// waits at pending_approval, is Approved (no money moves), and only Execute
// sends it to the rail. That separation mirrors the Go API exactly — approval
// is auditable on its own, and the act that moves money is one explicit click.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatCurrency } from "@/components/admin/metrics/format";
import {
  StatusBadge,
  type Tone,
} from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";

interface PayoutBatch {
  id: string;
  payeeType: string;
  payeeId: string;
  payeeName: string;
  businessDate: string;
  state: string;
  amount: number;
  currency: string;
  destination: string;
  provider: string;
  providerRef?: string;
  providerUtr?: string;
  failureCode?: string;
  failureDetail?: string;
  createdAt: string;
}

interface BatchesResponse {
  batches: PayoutBatch[];
  count: number;
}

function batchTone(state: string): Tone {
  switch (state) {
    case "paid":
      return "success";
    case "pending_approval":
      return "warning";
    case "approved":
    case "executing":
      return "info";
    case "failed":
    case "reversed":
      return "danger";
    default:
      return "neutral";
  }
}

export function PayoutBatchesPanel({ chefId }: { chefId?: string }) {
  const { data, isLoading, mutate } = useSWR<BatchesResponse>(
    ["/payouts/batches", chefId ? { payeeId: chefId } : {}],
    swrFetcher,
  );
  const { confirm, prompt } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = data?.batches ?? [];

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function approve(b: PayoutBatch) {
    const ok = await confirm({
      title: "Approve payout batch",
      message: `Approve ${formatCurrency(b.amount, b.currency || "INR")} to ${b.payeeName || b.payeeId.slice(0, 8)} (${b.destination || "destination on file"})? No money moves yet — execution is a separate step.`,
      confirmLabel: "Approve",
    });
    if (!ok) return;
    await run(b.id, () => hcAdmin.post(`/payouts/batches/${b.id}/approve`));
  }

  async function execute(b: PayoutBatch) {
    const ok = await confirm({
      title: "Execute payout — this moves money",
      message: `Send ${formatCurrency(b.amount, b.currency || "INR")} to ${b.payeeName || b.payeeId.slice(0, 8)} via Cashfree now? A payout cannot be reversed by the platform once it settles.`,
      confirmLabel: "Send the money",
      tone: "destructive",
    });
    if (!ok) return;
    await run(b.id, () => hcAdmin.post(`/payouts/batches/${b.id}/execute`));
  }

  // For an executing batch the same endpoint resolves the outcome against the
  // rail instead of re-sending — safe by design (guarded state transition).
  async function checkStatus(b: PayoutBatch) {
    await run(b.id, () => hcAdmin.post(`/payouts/batches/${b.id}/execute`));
  }

  async function cancel(b: PayoutBatch) {
    const reason = await prompt({
      title: "Cancel payout batch",
      message: `Abandon the ${formatCurrency(b.amount, b.currency || "INR")} batch for ${b.payeeName || b.payeeId.slice(0, 8)}? The statement stays pending and can be prepared again.`,
      label: "Reason",
      required: true,
      confirmLabel: "Cancel batch",
      tone: "destructive",
    });
    if (reason === null) return;
    await run(b.id, () =>
      hcAdmin.post(`/payouts/batches/${b.id}/cancel`, { reason }),
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Disbursement batches</h2>
        <p className="text-sm text-muted-foreground">
          Prepared from statements below. Approve clears a batch; Execute sends
          it to Cashfree. In-flight batches settle via the status poll — or
          “Check status” to resolve one now.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Payee</th>
              <th className="px-3 py-2 font-medium">Week ending</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Destination</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Reference</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No batches yet. Prepare one from a pending statement below.
                </td>
              </tr>
            ) : (
              rows.map((b) => {
                const busy = busyId === b.id;
                return (
                  <tr key={b.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium">
                      {b.payeeName || b.payeeId.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{b.businessDate}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {formatCurrency(b.amount, b.currency || "INR")}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {b.destination || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="space-y-1">
                        <StatusBadge
                          tone={batchTone(b.state)}
                          label={b.state.replace(/_/g, " ")}
                        />
                        {b.failureDetail ? (
                          <p
                            className="max-w-56 text-xs text-destructive"
                            title={b.failureDetail}
                          >
                            {b.failureCode ? `${b.failureCode}: ` : ""}
                            {b.failureDetail}
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td
                      className="px-3 py-2 font-mono text-xs"
                      title={b.providerRef ?? ""}
                    >
                      {b.providerUtr || b.providerRef || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        {b.state === "pending_approval" ? (
                          <button
                            onClick={() => void approve(b)}
                            disabled={busy}
                            className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background disabled:opacity-40"
                          >
                            {busy ? "…" : "Approve"}
                          </button>
                        ) : null}
                        {b.state === "approved" ? (
                          <button
                            onClick={() => void execute(b)}
                            disabled={busy}
                            className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background disabled:opacity-40"
                          >
                            {busy ? "…" : "Execute"}
                          </button>
                        ) : null}
                        {b.state === "executing" ? (
                          <button
                            onClick={() => void checkStatus(b)}
                            disabled={busy}
                            className="rounded-md border border-border px-2.5 py-1 text-xs disabled:opacity-40"
                          >
                            {busy ? "…" : "Check status"}
                          </button>
                        ) : null}
                        {b.state === "pending_approval" ||
                        b.state === "approved" ? (
                          <button
                            onClick={() => void cancel(b)}
                            disabled={busy}
                            className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40"
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
