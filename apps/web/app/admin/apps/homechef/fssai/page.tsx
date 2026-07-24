"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDate } from "@/lib/products/homechef/format";
import { StatusBadge } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type { FSSAILockedChef, FSSAILockResponse } from "@/lib/products/homechef/contracts";

// GET/POST /admin/fssai-expiry-backfill — chefs with a verified FSSAI licence but
// no recorded expiry. GET is a dry run (list), POST sends the confirm-licence push.
interface BackfillChef {
  chefId: string;
  userId: string;
  businessName: string;
}
interface BackfillResponse {
  count: number;
  chefs: BackfillChef[];
  executed: boolean;
  notified: number;
}

export default function HomechefFssaiPage() {
  const { data, isLoading, mutate } = useSWR<FSSAILockResponse>(
    ["/chefs/fssai-locked"],
    swrFetcher,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [backfill, setBackfill] = useState<BackfillChef[] | null>(null);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const { confirm, prompt } = useConfirm();

  async function viewBackfill() {
    if (backfillOpen) {
      setBackfillOpen(false);
      return;
    }
    setError(null);
    setBackfillOpen(true);
    if (backfill) return;
    setBackfillLoading(true);
    try {
      const res = await hcAdmin.get<BackfillResponse>("/fssai-expiry-backfill");
      setBackfill(res.chefs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load backfill list");
      setBackfillOpen(false);
    } finally {
      setBackfillLoading(false);
    }
  }

  async function notifyBackfill() {
    const ok = await confirm({
      title: "Send confirm-licence push",
      message:
        "Send a one-time push asking every chef with a missing FSSAI expiry to confirm their licence?",
      confirmLabel: "Send push",
    });
    if (!ok) return;
    setError(null);
    setNotice(null);
    setBackfillBusy(true);
    try {
      const res = await hcAdmin.post<BackfillResponse>("/fssai-expiry-backfill");
      setBackfill(res.chefs);
      setNotice(`Confirm-licence push sent to ${res.notified} chef(s).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Notify failed");
    } finally {
      setBackfillBusy(false);
    }
  }

  async function grant(ch: FSSAILockedChef) {
    setError(null);
    const reason = await prompt({
      title: `Grant FSSAI override — ${ch.businessName}`,
      message: "Temporarily lift the FSSAI lock so this kitchen can keep operating.",
      label: "Reason (min 10 characters)",
      placeholder: "Why is this override justified?",
      multiline: true,
      required: true,
      minLength: 10,
      confirmLabel: "Next",
    });
    if (reason === null) return;
    const daysStr = await prompt({
      title: "Override duration",
      message: "How long should the override last?",
      label: "Days (1–30)",
      placeholder: "7",
      defaultValue: "7",
      numeric: true,
      required: true,
      confirmLabel: "Grant override",
    });
    if (daysStr === null) return;
    const days = Number(daysStr);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      setError("Days must be a whole number between 1 and 30.");
      return;
    }
    setBusyId(ch.chefId);
    try {
      await hcAdmin.post(`/chefs/${ch.chefId}/fssai-override`, { reason, days });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Override failed");
    } finally {
      setBusyId(null);
    }
  }

  async function clear(ch: FSSAILockedChef) {
    const ok = await confirm({
      title: "Clear override",
      message: `Re-lock ${ch.businessName}? It will be blocked until its FSSAI licence is renewed.`,
      confirmLabel: "Clear override",
      tone: "destructive",
    });
    if (!ok) return;
    setError(null);
    setBusyId(ch.chefId);
    try {
      await hcAdmin.delete(`/chefs/${ch.chefId}/fssai-override`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">FSSAI Lockouts</h1>
        <p className="text-sm text-muted-foreground">
          {data
            ? `${data.lockedCount} locked · ${data.overriddenCount} overridden`
            : "Expired licences"}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}

      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {data.missingExpiryCount > 0 ? (
            <div className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {data.missingExpiryCount} chef(s) have no FSSAI expiry on record.
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={viewBackfill}>
                    {backfillOpen ? "Hide" : "View"}
                  </Button>
                  <Button size="sm" disabled={backfillBusy} onClick={notifyBackfill}>
                    {backfillBusy ? "Notifying…" : "Notify"}
                  </Button>
                </div>
              </div>
              {backfillOpen ? (
                backfillLoading ? (
                  <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
                ) : backfill && backfill.length > 0 ? (
                  <ul className="mt-3 space-y-1 text-sm">
                    {backfill.map((ch) => (
                      <li key={ch.chefId} className="text-foreground">
                        {ch.businessName}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">
                    No chefs pending an expiry confirmation.
                  </p>
                )
              ) : null}
            </div>
          ) : null}

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
              Locked ({data.lockedCount})
            </h2>
            {data.locked.length === 0 ? (
              <p className="text-sm text-muted-foreground">None locked.</p>
            ) : (
              <div className="space-y-2">
                {data.locked.map((ch) => (
                  <div
                    key={ch.chefId}
                    className="flex items-center justify-between rounded-lg border border-border p-3"
                  >
                    <div>
                      <div className="font-medium text-foreground">{ch.businessName}</div>
                      <div className="text-xs text-muted-foreground">
                        Expiry {ch.fssaiExpiry ? formatDate(ch.fssaiExpiry) : "unknown"} ·{" "}
                        {ch.daysSinceExpiry}d expired
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge label="Locked" tone="danger" />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === ch.chefId}
                        onClick={() => grant(ch)}
                      >
                        Grant override
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
              Overridden ({data.overriddenCount})
            </h2>
            {data.overridden.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active overrides.</p>
            ) : (
              <div className="space-y-2">
                {data.overridden.map((ch) => (
                  <div
                    key={ch.chefId}
                    className="flex items-center justify-between rounded-lg border border-border p-3"
                  >
                    <div>
                      <div className="font-medium text-foreground">{ch.businessName}</div>
                      <div className="text-xs text-muted-foreground">
                        Until {ch.overrideUntil ? formatDate(ch.overrideUntil) : "—"}
                        {ch.overrideReason ? ` · ${ch.overrideReason}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge label="Override active" tone="info" />
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busyId === ch.chefId}
                        onClick={() => clear(ch)}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
