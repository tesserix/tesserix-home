"use client";

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { StatusBadge } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";

interface SettlementAccount {
  bankAccountName: string;
  bankAccountNumber: string;
  bankIFSC: string;
  configured: boolean;
}

export function SettlementAccountPanel() {
  const { data, isLoading, mutate } = useSWR<SettlementAccount>(
    ["/platform/settlement-account", {}],
    swrFetcher,
  );
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [account, setAccount] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  async function saveAccount() {
    if (!name.trim() || !account.trim() || !ifsc.trim()) {
      setError("Account holder, account number and IFSC are all required.");
      return;
    }
    const ok = await confirm({
      title: "Save company settlement account?",
      message:
        "This is the record of the current account Cashfree settles the company's share to. " +
        "It must match the settlement account verified in the Cashfree merchant dashboard — " +
        "changing it here does NOT change it at Cashfree; do that in their dashboard (KYC re-verification applies).",
      confirmLabel: "Save",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await hcAdmin.put(`/platform/settlement-account`, {
        bankAccountName: name.trim(),
        bankAccountNumber: account.trim(),
        bankIFSC: ifsc.trim(),
      });
      setEditing(false);
      setName("");
      setAccount("");
      setIfsc("");
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading || !data) return null;

  return (
    <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Company settlement account</h3>
          <StatusBadge
            tone={data.configured ? "success" : "warning"}
            label={data.configured ? "On file" : "Not set"}
          />
        </div>
        <button
          onClick={() => setEditing((e) => !e)}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          {editing ? "Cancel" : data.configured ? "Update" : "Set account"}
        </button>
      </div>

      {data.configured && !editing ? (
        <div className="grid gap-1 text-sm sm:grid-cols-3">
          <div>
            <span className="text-xs text-muted-foreground">Account holder</span>
            <p>{data.bankAccountName || "—"}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Account</span>
            <p className="font-mono text-xs">{data.bankAccountNumber || "—"}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">IFSC</span>
            <p className="font-mono text-xs">{data.bankIFSC || "—"}</p>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Account holder (legal name)
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 w-56 rounded-md border border-border bg-background px-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Current account number
            <input
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              inputMode="numeric"
              className="h-9 w-52 rounded-md border border-border bg-background px-2 font-mono text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            IFSC
            <input
              value={ifsc}
              onChange={(e) => setIfsc(e.target.value.toUpperCase())}
              className="h-9 w-36 rounded-md border border-border bg-background px-2 font-mono text-sm"
            />
          </label>
          <button
            onClick={() => void saveAccount()}
            disabled={busy}
            className="h-9 rounded-md bg-foreground px-4 text-sm font-medium text-background disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Where Cashfree pays the company&apos;s share — commission, GST, TDS,
        delivery money and the flat platform fee — on its settlement schedule.
        Stored in Secret Manager, shown masked. The authoritative account is the
        KYC-verified one in the Cashfree merchant dashboard; keep the two in
        sync.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
