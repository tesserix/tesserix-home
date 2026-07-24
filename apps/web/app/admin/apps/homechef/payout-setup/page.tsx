"use client";

// HomeChef PAYOUT SETUP page (#747). Lists every chef whose Razorpay linked
// account is not yet "activated" — so any payout attempt to them would simply
// fail — alongside Razorpay's own requirements (what it needs before it will
// activate the account) and the per-chef payout-automation switch. This is the
// surface an admin uses to see why a chef is unpaid and fix it: chase the
// Razorpay requirement, or suspend automation until the chef sorts it out.
//
// Distinct from the release queue (/payout-queue, #388): that page moves money
// on already-eligible holds. This page is about chefs who cannot be paid at
// all yet, plus the automation switch that decides whether their eligible
// holds will auto-release once they can be.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { titleCase } from "@/lib/products/homechef/format";
import { useConfirm } from "@/components/admin/confirm-dialog";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import {
  parseSettlementRequirements,
  type BlockedChef,
  type BlockedChefsResponse,
  type PayoutAutomationValue,
} from "@/lib/products/homechef/contracts";

function settlementTone(status: string): Tone {
  switch (status) {
    case "needs_clarification":
      return "warning";
    case "created":
      return "info";
    case "activated":
      return "success";
    default:
      return "neutral";
  }
}

function settlementLabel(status: string): string {
  return status ? titleCase(status) : "Not started";
}

// Shown whenever Razorpay gave no requirements string for this chef — status
// alone doesn't tell an admin what to do, so every status gets an explanation.
function noRequirementsNote(status: string): string {
  switch (status) {
    case "needs_clarification":
      return "Razorpay flagged this account but returned no specific field.";
    case "created":
      return "Awaiting Razorpay review.";
    default:
      return "Chef has not submitted bank details.";
  }
}

const AUTOMATION_OPTIONS: { value: PayoutAutomationValue; label: string }[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "", label: "Default" },
];

function RequirementsCell({ chef }: { chef: BlockedChef }) {
  if (!chef.requirements) {
    return <p className="text-xs text-muted-foreground">{noRequirementsNote(chef.settlementStatus)}</p>;
  }
  const parsed = parseSettlementRequirements(chef.requirements);
  if (parsed === null) {
    // Malformed blob — show it raw rather than hiding it or crashing the page.
    return <p className="break-all text-xs text-muted-foreground">{chef.requirements}</p>;
  }
  if (parsed.length === 0) {
    return <p className="text-xs text-muted-foreground">{noRequirementsNote(chef.settlementStatus)}</p>;
  }
  return (
    <ul className="space-y-1 text-xs">
      {parsed.map((r, i) => (
        <li key={i}>
          <span className="font-medium text-foreground">
            {r.field_reference ? titleCase(r.field_reference.replace(/[._]+/g, " ")) : "Unspecified field"}
          </span>
          {r.reason_code ? <span className="text-muted-foreground"> — {titleCase(r.reason_code)}</span> : null}
          {r.resolution_url ? (
            <>
              {" · "}
              <a
                href={r.resolution_url}
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline underline-offset-2"
              >
                Resolve
              </a>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function HomechefPayoutSetupPage() {
  const {
    data,
    isLoading,
    error: loadError,
    mutate,
  } = useSWR<BlockedChefsResponse>(["/payouts/blocked-chefs", {}], swrFetcher);
  const { confirm } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = data?.chefs ?? [];
  const displayError =
    actionError ??
    (loadError ? (loadError instanceof Error ? loadError.message : "Failed to load blocked chefs") : null);

  async function setAutomation(chef: BlockedChef, value: PayoutAutomationValue) {
    if (value === "off") {
      const ok = await confirm({
        title: "Suspend payout automation",
        message: `Turn OFF automated payouts for ${chef.businessName}? Their eligible holds will need manual release from the Release Queue until this is turned back on.`,
        confirmLabel: "Turn off",
        tone: "destructive",
      });
      if (!ok) return;
    }
    setActionError(null);
    setBusyId(chef.chefId);
    try {
      await hcAdmin.put(`/chefs/${chef.chefId}/payout-automation`, { value });
      await mutate();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to update payout automation");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Payout setup</h1>
        <p className="text-sm text-muted-foreground">
          {data
            ? `${rows.length} chef${rows.length === 1 ? "" : "s"} blocked from payout`
            : "Chefs Razorpay has not activated for payout, and their automation switch"}
        </p>
      </div>

      {displayError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {displayError}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Chef</th>
              <th className="px-4 py-3">Settlement status</th>
              <th className="px-4 py-3">What Razorpay needs</th>
              <th className="px-4 py-3 text-right">Payout automation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                  No chefs are blocked from payout
                </td>
              </tr>
            ) : (
              rows.map((chef) => {
                const busy = busyId === chef.chefId;
                return (
                  <tr key={chef.chefId} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium text-foreground">
                      <div>{chef.businessName || chef.chefId.slice(0, 8)}</div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {chef.chefId.slice(0, 8)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        label={settlementLabel(chef.settlementStatus)}
                        tone={settlementTone(chef.settlementStatus)}
                      />
                    </td>
                    <td className="max-w-md px-4 py-3">
                      <RequirementsCell chef={chef} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex gap-1">
                          {AUTOMATION_OPTIONS.map((opt) => {
                            const active = chef.payoutAutoRelease === opt.value;
                            return (
                              <button
                                key={opt.value || "default"}
                                onClick={() => setAutomation(chef, opt.value)}
                                disabled={busy}
                                aria-pressed={active}
                                className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                                  active
                                    ? "bg-foreground text-background"
                                    : "border border-border text-foreground hover:bg-muted"
                                }`}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                        {busy ? (
                          <span className="text-[11px] text-muted-foreground">Updating…</span>
                        ) : chef.payoutAutoRelease === "" ? (
                          <span className="text-[11px] text-muted-foreground">Following platform default</span>
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
    </div>
  );
}
