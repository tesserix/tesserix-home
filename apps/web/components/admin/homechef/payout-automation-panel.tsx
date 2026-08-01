"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { StatusBadge } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";

interface PayoutSettings {
  autoDisburseEnabled: boolean;
  autoCapMinor: number;
  autoCapUnreadable: boolean;
}

export function PayoutAutomationPanel() {
  const { data, isLoading, mutate } = useSWR<PayoutSettings>(
    ["/payouts/settings", {}],
    swrFetcher,
  );
  const [capRupees, setCapRupees] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  useEffect(() => {
    if (data) setCapRupees(data.autoCapMinor > 0 ? String(data.autoCapMinor / 100) : "");
  }, [data]);

  async function save(body: { autoDisburseEnabled?: boolean; autoCapMinor?: number }) {
    setBusy(true);
    setError(null);
    try {
      await hcAdmin.put(`/payouts/settings`, body);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (!data) return;
    if (!data.autoDisburseEnabled) {
      const ok = await confirm({
        title: "Enable auto-approval platform-wide?",
        message:
          "Prepared batches for chefs on the default setting will skip manual approval. " +
          "First disbursements to a new account and amounts above the cap still queue for " +
          "review, and execution stays a separate admin step. Per-chef overrides win either way.",
        confirmLabel: "Enable",
      });
      if (!ok) return;
    }
    await save({ autoDisburseEnabled: !data.autoDisburseEnabled });
  }

  async function saveCap() {
    const trimmed = capRupees.trim();
    const rupees = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(rupees) || rupees < 0) {
      setError("Cap must be a non-negative amount in rupees.");
      return;
    }
    await save({ autoCapMinor: Math.round(rupees * 100) });
  }

  if (isLoading || !data) return null;

  return (
    <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Batch auto-approval</h3>
          <StatusBadge
            tone={data.autoDisburseEnabled ? "success" : "neutral"}
            label={data.autoDisburseEnabled ? "On by default" : "Manual by default"}
          />
          {data.autoCapUnreadable ? (
            <StatusBadge tone="danger" label="Cap unreadable — all manual" />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Auto-approve cap ₹
            <input
              value={capRupees}
              onChange={(e) => setCapRupees(e.target.value)}
              placeholder="no cap"
              inputMode="decimal"
              className="h-8 w-28 rounded-md border border-border bg-background px-2 tabular-nums"
              aria-label="Auto-approve cap in rupees"
            />
          </label>
          <button
            onClick={() => void saveCap()}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            Save cap
          </button>
          <button
            onClick={() => void toggle()}
            disabled={busy}
            className={
              "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 " +
              (data.autoDisburseEnabled
                ? "border border-border hover:bg-accent"
                : "bg-foreground text-background")
            }
          >
            {data.autoDisburseEnabled ? "Turn off" : "Turn on"}
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Governs whether prepared Cashfree batches land pre-approved for chefs on
        the default setting; per-chef switches override it. A first disbursement
        to a new destination always waits for a human, an empty cap means no
        amount limit, and every batch still requires an explicit Execute.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
