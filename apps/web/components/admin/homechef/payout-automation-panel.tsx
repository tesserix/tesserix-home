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
  easySplitEnabled: boolean;
  commissionRatePercent: number;
  platformFeeFlatMinor: number;
  platformFeeUnreadable: boolean;
}

export function PayoutAutomationPanel() {
  const { data, isLoading, mutate } = useSWR<PayoutSettings>(
    ["/payouts/settings", {}],
    swrFetcher,
  );
  const [capRupees, setCapRupees] = useState("");
  const [feeRupees, setFeeRupees] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  useEffect(() => {
    if (!data) return;
    setCapRupees(data.autoCapMinor > 0 ? String(data.autoCapMinor / 100) : "");
    setFeeRupees(data.platformFeeFlatMinor > 0 ? String(data.platformFeeFlatMinor / 100) : "");
  }, [data]);

  async function save(body: {
    autoDisburseEnabled?: boolean;
    autoCapMinor?: number;
    easySplitEnabled?: boolean;
    platformFeeFlatMinor?: number;
  }) {
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

  async function toggleEasySplit() {
    if (!data) return;
    if (!data.easySplitEnabled) {
      const ok = await confirm({
        title: "Enable Easy Split?",
        message:
          "Each chef's net share will be paid straight out of the capture once the release " +
          "governor clears the order — the platform never holds their money. Only chefs with " +
          "an ACTIVE Easy Split vendor are split; everyone else stays on the weekly statement " +
          `path. The remainder — the ${data.commissionRatePercent}% commission, GST, TDS, ` +
          "delivery money and any extra flat fee — settles to the company account.",
        confirmLabel: "Enable Easy Split",
      });
      if (!ok) return;
    }
    await save({ easySplitEnabled: !data.easySplitEnabled });
  }

  async function saveFee() {
    const trimmed = feeRupees.trim();
    const rupees = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(rupees) || rupees < 0) {
      setError("Fee must be a non-negative amount in rupees.");
      return;
    }
    await save({ platformFeeFlatMinor: Math.round(rupees * 100) });
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

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Split after payment (Easy Split)</h3>
          <StatusBadge
            tone={data.easySplitEnabled ? "success" : "neutral"}
            label={data.easySplitEnabled ? "On" : "Off"}
          />
          <StatusBadge
            tone="neutral"
            label={`Commission ${data.commissionRatePercent}%`}
          />
          {data.platformFeeUnreadable ? (
            <StatusBadge tone="danger" label="Fee unreadable — splits paused" />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Extra flat fee ₹
            <input
              value={feeRupees}
              onChange={(e) => setFeeRupees(e.target.value)}
              placeholder="0"
              inputMode="decimal"
              className="h-8 w-24 rounded-md border border-border bg-background px-2 tabular-nums"
              aria-label="Extra flat platform fee per order in rupees, optional"
            />
          </label>
          <button
            onClick={() => void saveFee()}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            Save fee
          </button>
          <button
            onClick={() => void toggleEasySplit()}
            disabled={busy}
            className={
              "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 " +
              (data.easySplitEnabled
                ? "border border-border hover:bg-accent"
                : "bg-foreground text-background")
            }
          >
            {data.easySplitEnabled ? "Turn off" : "Turn on"}
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        With Easy Split on, each released order settles the chef&apos;s net
        share out of the capture directly to their verified vendor account — the
        platform never holds it. The platform&apos;s cut is the{" "}
        {data.commissionRatePercent}% commission every order already carries — it
        is netted off before the split is built, so leaving the extra flat fee
        empty is correct unless you want a per-order charge on top of it. The
        company&apos;s remainder settles to the current account on file with
        Cashfree. Chefs without an ACTIVE vendor, credit-funded orders and
        lapsed-FSSAI kitchens stay on the statement path.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
