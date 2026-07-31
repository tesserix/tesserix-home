"use client";

// Per-chef payout profile — shown on /payouts when the list is filtered to one
// chef. Answers the two questions an operator has before approving money out:
// where does it go (masked destination) and does the RAIL agree it can (the
// beneficiary status Cashfree holds, not our opinion of it).

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import {
  StatusBadge,
  type Tone,
} from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";

export interface ChefPayoutMethod {
  id: string;
  kind: string;
  status: string;
  primary: boolean;
  displayHint: string;
  beneficiaryName: string;
  rail: string;
  railBeneficiaryId?: string;
  railStatusDetail?: string;
  verifiedAt?: string;
  payable: boolean;
}

interface ChefPayoutProfile {
  chef: { id: string; businessName: string; mode: string };
  payoutMethod: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankIFSC: string;
  upiId: string;
  razorpaySettlementStatus: string;
  methods: ChefPayoutMethod[];
  rail: { configured: boolean; sandbox: boolean; mode: string };
}

function methodTone(status: string): Tone {
  switch (status) {
    case "verified":
      return "success";
    case "pending":
      return "warning";
    case "invalid":
      return "danger";
    default:
      return "neutral";
  }
}

export function ChefPayoutProfileCard({ chefId }: { chefId: string }) {
  const { data, isLoading, mutate } = useSWR<ChefPayoutProfile>(
    [`/chefs/${chefId}/payout-profile`, {}],
    swrFetcher,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  async function run(action: string, fn: () => Promise<unknown>) {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const res = (await fn()) as { warning?: string; message?: string };
      setNotice(
        res?.warning
          ? `Gateway said: ${res.warning}`
          : (res?.message ?? "Updated."),
      );
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    await run("refresh", () =>
      hcAdmin.post(`/chefs/${chefId}/payout-methods/refresh`),
    );
  }

  async function seedTestBank() {
    const ok = await confirm({
      title: "Register the sandbox test bank account?",
      message:
        "Puts one of Cashfree's documented sandbox test accounts on file for this chef and registers it with the SANDBOX rail. Refused automatically if this chef's mode resolves to the live rail.",
      confirmLabel: "Register test account",
    });
    if (!ok) return;
    await run("seed", () =>
      hcAdmin.post(`/chefs/${chefId}/payout-methods/test-bank`),
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        Loading chef payout profile…
      </div>
    );
  }
  if (!data) return null;

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">
            {data.chef.businessName || data.chef.id.slice(0, 8)} — payout
            destination
          </h3>
          <p className="text-sm text-muted-foreground">
            What the disbursement rail will pay against. Money moves only to a
            destination Cashfree has verified.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge
            tone={data.chef.mode === "live" ? "warning" : "info"}
            label={data.chef.mode === "live" ? "LIVE mode" : "Test mode"}
          />
          {!data.rail.configured ? (
            <StatusBadge tone="neutral" label="Rail not configured" />
          ) : (
            <StatusBadge
              tone={data.rail.sandbox ? "info" : "warning"}
              label={data.rail.sandbox ? "Sandbox rail" : "Live rail"}
            />
          )}
        </div>
      </div>

      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-md border border-border p-3">
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">Method</span>
            <span>{data.payoutMethod || "—"}</span>
          </div>
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">Account holder</span>
            <span>{data.bankAccountName || "—"}</span>
          </div>
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">Account</span>
            <span className="font-mono text-xs">
              {data.bankAccountNumber || "—"}
            </span>
          </div>
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">IFSC</span>
            <span className="font-mono text-xs">{data.bankIFSC || "—"}</span>
          </div>
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">Razorpay settlement</span>
            <span>{data.razorpaySettlementStatus || "—"}</span>
          </div>
        </div>

        <div className="space-y-2 rounded-md border border-border p-3">
          {data.methods.length === 0 ? (
            <p className="text-muted-foreground">
              No rail registration yet. Use “Refresh from Cashfree” once bank
              details are on file{data.rail.sandbox ? ", or register the sandbox test account" : ""}.
            </p>
          ) : (
            data.methods.map((m) => (
              <div key={m.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={methodTone(m.status)} label={m.status} />
                  <span className="font-mono text-xs">{m.displayHint}</span>
                  <span className="text-muted-foreground">
                    {m.kind === "upi" ? "UPI" : "Bank"} · {m.beneficiaryName}
                  </span>
                </div>
                {m.railStatusDetail ? (
                  <p className="text-xs text-destructive">
                    {m.railStatusDetail}
                  </p>
                ) : null}
                {m.verifiedAt ? (
                  <p className="text-xs text-muted-foreground">
                    Verified {m.verifiedAt.slice(0, 10)}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void refresh()}
          disabled={busy !== null || !data.rail.configured}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          {busy === "refresh" ? "Refreshing…" : "Refresh from Cashfree"}
        </button>
        {data.rail.sandbox ? (
          <button
            onClick={() => void seedTestBank()}
            disabled={busy !== null}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {busy === "seed" ? "Registering…" : "Register sandbox test account"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
