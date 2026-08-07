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
  methods: ChefPayoutMethod[];
  rail: { configured: boolean; sandbox: boolean; mode: string };
  automation?: {
    disburse: string;
    globalAutoDisburse: boolean;
    effective: boolean;
    autoCapMinor: number;
    autoCapUnreadable: boolean;
  };
  easySplit?: {
    enabled: boolean;
    vendorId: string;
    status: string;
  };
}

const AUTOMATION_CHOICES = [
  { value: "", label: "Default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

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

  async function setAutomation(value: string) {
    if (value === "on") {
      const ok = await confirm({
        title: "Auto-approve this chef's payout batches?",
        message:
          "New batches for this chef will skip manual approval and land ready to execute. " +
          "Guardrails still hold: the destination must be Cashfree-verified, the first " +
          "disbursement to a new bank account always waits for a human, and amounts above " +
          "the auto-approval cap queue for review.",
        confirmLabel: "Enable auto-approve",
      });
      if (!ok) return;
    }
    await run(`auto-${value || "default"}`, () =>
      hcAdmin.put(`/chefs/${chefId}/disburse-automation`, { value }),
    );
  }

  async function registerEasySplit() {
    const ok = await confirm({
      title: "Register this chef as an Easy Split vendor?",
      message:
        "Sends the chef's bank details on file to Cashfree Easy Split. Once Cashfree verifies " +
        "the destination (status ACTIVE), paid orders settle the chef's net share straight " +
        "from capture — the platform never holds their money.",
      confirmLabel: "Register vendor",
    });
    if (!ok) return;
    await run("es-register", () =>
      hcAdmin.post(`/chefs/${chefId}/easy-split/register`),
    );
  }

  async function refreshEasySplit() {
    await run("es-refresh", () =>
      hcAdmin.post(`/chefs/${chefId}/easy-split/refresh`),
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

      {data.easySplit ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">Easy Split vendor</span>
              <StatusBadge
                tone={
                  data.easySplit.status === "ACTIVE"
                    ? "success"
                    : data.easySplit.status
                      ? "warning"
                      : "neutral"
                }
                label={data.easySplit.status || "Not registered"}
              />
              {!data.easySplit.enabled ? (
                <span className="text-xs text-muted-foreground">
                  (split-at-capture is off platform-wide)
                </span>
              ) : null}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void registerEasySplit()}
                disabled={busy !== null}
                className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
              >
                {busy === "es-register"
                  ? "Registering…"
                  : data.easySplit.vendorId
                    ? "Re-register"
                    : "Register vendor"}
              </button>
              {data.easySplit.vendorId ? (
                <button
                  onClick={() => void refreshEasySplit()}
                  disabled={busy !== null}
                  className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {busy === "es-refresh" ? "Refreshing…" : "Refresh status"}
                </button>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            ACTIVE means Cashfree pays this chef&apos;s net share straight from
            each capture; anything else keeps the chef on the weekly statement
            path.
          </p>
        </div>
      ) : null}

      {data.automation ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">Batch auto-approve</span>
              <StatusBadge
                tone={data.automation.effective ? "success" : "neutral"}
                label={data.automation.effective ? "Active" : "Manual approval"}
              />
            </div>
            <div className="flex overflow-hidden rounded-md border border-border">
              {AUTOMATION_CHOICES.map((c) => (
                <button
                  key={c.value}
                  onClick={() => void setAutomation(c.value)}
                  disabled={busy !== null}
                  className={
                    "px-3 py-1 text-xs disabled:opacity-50 " +
                    (data.automation?.disburse === c.value
                      ? "bg-foreground text-background"
                      : "hover:bg-accent")
                  }
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {data.automation.disburse === ""
              ? `Following the global auto-disburse flag (${data.automation.globalAutoDisburse ? "on" : "off"}). `
              : `Overriding the global flag (${data.automation.globalAutoDisburse ? "on" : "off"}). `}
            Auto-approved batches still require a verified destination; the
            first disbursement to a new account is always manual
            {data.automation.autoCapUnreadable
              ? "; the auto-cap setting is unreadable, so everything queues for review"
              : data.automation.autoCapMinor > 0
                ? `; amounts above ₹${(data.automation.autoCapMinor / 100).toLocaleString("en-IN")} queue for review`
                : ""}
            . Execution remains a separate admin step.
          </p>
        </div>
      ) : null}

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
