"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, formatINR, titleCase } from "@/lib/products/homechef/format";
import type { WalletResponse } from "@/lib/products/homechef/contracts";

function WalletsInner() {
  const initial = useSearchParams().get("userId") ?? "";
  const [input, setInput] = useState(initial);
  const [active, setActive] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, mutate } = useSWR<WalletResponse>(
    active ? [`/wallet/${active}`] : null,
    swrFetcher,
  );

  // adjust form
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [type, setType] = useState<"credit" | "debit">("credit");
  const [saving, setSaving] = useState(false);

  async function adjust() {
    setError(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return setError("Enter an amount greater than zero.");
    if (!reason.trim()) return setError("A reason is required.");
    setSaving(true);
    try {
      await hcAdmin.post(`/wallet/${active}/adjust`, { amount: amt, reason: reason.trim(), type });
      setAmount("");
      setReason("");
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Adjustment failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Wallets</h1>
        <p className="text-sm text-muted-foreground">Customer store credit — ledger & adjustments</p>
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Customer user ID…"
          className="h-9 w-96 rounded-md border border-border bg-background px-3 text-sm"
        />
        <Button size="sm" onClick={() => setActive(input.trim())}>
          Load
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {!active ? (
        <p className="text-sm text-muted-foreground">
          Enter a customer user ID, or open a wallet from the Users list.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">No wallet found.</p>
      ) : (
        <div className="space-y-6">
          <div className="rounded-lg border border-border p-4">
            <div className="text-sm text-muted-foreground">Balance</div>
            <div className="text-3xl font-semibold text-foreground tabular-nums">
              {formatINR(data.balance)}
            </div>
          </div>

          <div className="rounded-lg border border-border p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase text-muted-foreground">
              Adjust balance
            </h2>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex gap-1">
                {(["credit", "debit"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    className={`rounded-md px-3 py-1.5 text-sm ${
                      type === t
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                    }`}
                  >
                    {t === "credit" ? "Credit (+)" : "Debit (−)"}
                  </button>
                ))}
              </div>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="Amount (₹)"
                className="h-9 w-32 rounded-md border border-border bg-background px-3 text-sm"
              />
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason"
                className="h-9 flex-1 min-w-48 rounded-md border border-border bg-background px-3 text-sm"
              />
              <Button size="sm" disabled={saving} onClick={adjust}>
                {saving ? "Saving…" : "Apply"}
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.transactions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      No transactions.
                    </td>
                  </tr>
                ) : (
                  data.transactions.map((t) => (
                    <tr key={t.id}>
                      <td className="px-4 py-3 text-foreground">{titleCase(t.source)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{t.reason}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDateTime(t.createdAt)}</td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums ${
                          t.type === "credit" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {t.type === "credit" ? "+" : "−"}
                        {formatINR(t.amount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function HomechefWalletsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading…</div>}>
      <WalletsInner />
    </Suspense>
  );
}
