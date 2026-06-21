"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDate } from "@/lib/products/homechef/format";
import { StatusBadge } from "@/components/admin/homechef/status-badge";
import type { FSSAILockedChef, FSSAILockResponse } from "@/lib/products/homechef/contracts";

export default function HomechefFssaiPage() {
  const { data, isLoading, mutate } = useSWR<FSSAILockResponse>(
    ["/chefs/fssai-locked"],
    swrFetcher,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function grant(ch: FSSAILockedChef) {
    setError(null);
    const reason = window.prompt("Override reason (min 10 chars):")?.trim() ?? "";
    if (reason.length < 10) {
      if (reason) setError("Reason must be at least 10 characters.");
      return;
    }
    const daysStr = window.prompt("Override duration in days (1–30):", "7")?.trim() ?? "";
    const days = Number(daysStr);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      setError("Days must be an integer between 1 and 30.");
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
    if (!window.confirm(`Re-lock ${ch.businessName}?`)) return;
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

      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {data.missingExpiryCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              {data.missingExpiryCount} chef(s) have no FSSAI expiry on record.
            </p>
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
