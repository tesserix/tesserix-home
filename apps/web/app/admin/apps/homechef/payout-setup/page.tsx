"use client";

// HomeChef PAYOUT SETUP page (#747). Lists every chef whose Cashfree vendor is
// not ACTIVE — order money cannot reach them — with the server's plain-words
// reason and the per-chef payout-automation switch. This is the surface an
// admin uses to see why a chef is unpaid and fix it: chase the failed
// verification, or suspend automation until the chef sorts it out.
//
// Distinct from the release queue (/payout-queue, #388): that page moves money
// on already-eligible holds. This page is about chefs who cannot be paid at
// all yet, plus the automation switch that decides whether their eligible
// holds will auto-release once they can be.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { titleCase, type BlockedChef, type BlockedChefsResponse, type PayoutAutomationValue, type PayoutRegistrationState } from "@tesserix/homechef-shared";
import { useConfirm } from "@/components/admin/confirm-dialog";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";

function registrationTone(state: PayoutRegistrationState): Tone {
  switch (state) {
    case "verified":
      return "success";
    case "failed":
      return "warning";
    case "pending":
      return "info";
    default:
      return "neutral";
  }
}

const AUTOMATION_OPTIONS: { value: PayoutAutomationValue; label: string }[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "", label: "Default" },
];

// The server owns the wording (#1082); the raw Cashfree status sits underneath
// it for the operator, who is the only reader allowed to see gateway strings.
function ReasonCell({ chef }: { chef: BlockedChef }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-foreground">{chef.registration.message}</p>
      {chef.vendorStatus ? (
        <p className="text-xs text-muted-foreground">Cashfree: {chef.vendorStatus}</p>
      ) : null}
    </div>
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
            : "Chefs Cashfree has not verified for payout, and their automation switch"}
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
              <th className="px-4 py-3">Registration</th>
              <th className="px-4 py-3">Why they&apos;re blocked</th>
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
                        label={titleCase(chef.registration.state)}
                        tone={registrationTone(chef.registration.state)}
                      />
                    </td>
                    <td className="max-w-md px-4 py-3">
                      <ReasonCell chef={chef} />
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
