"use client";

// HomeChef admin payout RELEASE QUEUE (#388). Distinct from the weekly-statement
// disbursement page (/payouts, #389): this lists per-order/per-tiffin-day escrow
// holds the customer (or the 24h auto-confirm sweep) advanced to
// `release_eligible`, and lets an admin release / withhold / reverse each —
// driving the Go `/admin/payouts/*` actuator.
//
// Money only actually moves when the escrow flags are live; until then these
// actions advance the DB hold state only (safe to operate pre-launch).

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatINR, titleCase } from "@/lib/products/homechef/format";
import { useConfirm } from "@/components/admin/confirm-dialog";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import type {
  PayoutHoldStatus,
  PendingPayout,
  PendingPayoutsResponse,
} from "@/lib/products/homechef/contracts";

const SLA_HOURS = 24;

function holdTone(status: PayoutHoldStatus): Tone {
  switch (status) {
    case "release_eligible":
      return "success";
    case "awaiting_customer_confirmation":
    case "withheld":
      return "warning";
    case "released":
      return "info";
    case "reversed":
    case "disputed":
      return "danger";
    default:
      return "neutral";
  }
}

function ageLabel(hours: number): { label: string; overdue: boolean } {
  const rounded = Math.max(0, Math.round(hours));
  const label = rounded >= 48 ? `${Math.round(rounded / 24)}d` : `${rounded}h`;
  return { label, overdue: hours > SLA_HOURS };
}

export default function HomechefPayoutQueuePage() {
  const [includeAwaiting, setIncludeAwaiting] = useState(false);
  const { data, isLoading, mutate } = useSWR<PendingPayoutsResponse>(
    ["/payouts/pending", includeAwaiting ? { include: "awaiting" } : {}],
    swrFetcher,
  );
  const { confirm, prompt } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = data?.payouts ?? [];
  // An open issue holds the money back — keep those out of the one-click batch.
  const eligible = rows.filter((p) => p.holdStatus === "release_eligible" && !p.hasOpenIssue);

  function actionPath(p: PendingPayout, action: string): string {
    return `/payouts/${p.aggType}/${p.id}/${action}`;
  }

  async function run(fn: () => Promise<unknown>, id: string, fallback: string) {
    setError(null);
    setBusyId(id);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusyId(null);
    }
  }

  async function release(p: PendingPayout) {
    const ok = await confirm({
      title: "Release payout",
      message: p.hasOpenIssue
        ? `This payout has an OPEN ISSUE. Release ${formatINR(p.netPayout)} to the chef for ${p.context} anyway? Resolve the issue first unless you are sure.`
        : `Release ${formatINR(p.netPayout)} to the chef for ${p.context}? This settles the held transfer (when escrow is live).`,
      confirmLabel: "Release",
      tone: p.hasOpenIssue ? "destructive" : "default",
    });
    if (!ok) return;
    await run(() => hcAdmin.post(actionPath(p, "release")), p.id, "Release failed");
  }

  async function withhold(p: PendingPayout) {
    const reason = await prompt({
      title: "Withhold payout",
      message: `Park ${formatINR(p.amount)} for ${p.context}. It will be excluded from release until resolved.`,
      label: "Reason",
      required: true,
      multiline: true,
      confirmLabel: "Withhold",
    });
    if (reason === null) return;
    await run(() => hcAdmin.post(actionPath(p, "withhold"), { reason }), p.id, "Withhold failed");
  }

  async function reverse(p: PendingPayout) {
    const reason = await prompt({
      title: "Reverse payout",
      message: `Claw back ${formatINR(p.amount)} for ${p.context} to the platform. Use for a confirmed fault after release.`,
      label: "Reason",
      required: true,
      multiline: true,
      confirmLabel: "Reverse",
      tone: "destructive",
    });
    if (reason === null) return;
    await run(() => hcAdmin.post(actionPath(p, "reverse"), { reason }), p.id, "Reverse failed");
  }

  async function releaseAll() {
    if (eligible.length === 0) return;
    const ok = await confirm({
      title: "Release all eligible",
      message: `Release ${eligible.length} eligible payout${eligible.length === 1 ? "" : "s"} in one batch? Ineligible holds are skipped.`,
      confirmLabel: `Release ${eligible.length}`,
    });
    if (!ok) return;
    await run(
      () =>
        hcAdmin.post("/payouts/release-bulk", {
          items: eligible.map((p) => ({ aggType: p.aggType, id: p.id })),
        }),
      "bulk",
      "Bulk release failed",
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Release Queue</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${eligible.length} eligible · ${rows.length} shown` : "Escrow hold release queue"}{" "}
            · manual release — money moves only when escrow is live
          </p>
        </div>
        <button
          onClick={releaseAll}
          disabled={eligible.length === 0 || busyId !== null}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-40"
        >
          {busyId === "bulk" ? "Releasing…" : `Release all (${eligible.length})`}
        </button>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => setIncludeAwaiting(false)}
          className={`rounded-md px-3 py-1.5 text-sm ${
            !includeAwaiting
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-muted/70"
          }`}
        >
          Eligible only
        </button>
        <button
          onClick={() => setIncludeAwaiting(true)}
          className={`rounded-md px-3 py-1.5 text-sm ${
            includeAwaiting
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-muted/70"
          }`}
        >
          Include awaiting
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Context</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Net payout</th>
              <th className="px-4 py-3">Confirmed</th>
              <th className="px-4 py-3">Age</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  No payouts awaiting action.
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const age = ageLabel(p.ageHours);
                const busy = busyId === p.id;
                const canRelease = p.holdStatus === "release_eligible";
                const typeLabel =
                  p.aggType === "meal-plan-day"
                    ? "Tiffin day"
                    : p.aggType === "group-order"
                      ? "Group order"
                      : "Order";
                return (
                  <tr key={`${p.aggType}:${p.id}`} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        {p.context || p.id.slice(0, 8)}
                        {p.hasOpenIssue ? (
                          <StatusBadge label="Open issue" tone="danger" />
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{typeLabel}</td>
                    <td className="px-4 py-3 tabular-nums">
                      <div>{formatINR(p.netPayout)}</div>
                      <div className="text-xs text-muted-foreground">
                        gross {formatINR(p.amount)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {p.customerConfirmedAt ? "Yes" : "Auto/—"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge label={age.label} tone={age.overdue ? "danger" : "neutral"} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge label={titleCase(p.holdStatus)} tone={holdTone(p.holdStatus)} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {canRelease && (
                          <button
                            onClick={() => release(p)}
                            disabled={busy}
                            className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                              p.hasOpenIssue
                                ? "border border-destructive/40 text-destructive hover:bg-destructive/10"
                                : "bg-foreground text-background"
                            }`}
                          >
                            {busy ? "…" : p.hasOpenIssue ? "Release (issue)" : "Release"}
                          </button>
                        )}
                        <button
                          onClick={() => withhold(p)}
                          disabled={busy || !canRelease}
                          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
                        >
                          Withhold
                        </button>
                        <button
                          onClick={() => reverse(p)}
                          disabled={busy}
                          className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40"
                        >
                          Reverse
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
