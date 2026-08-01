"use client";

// PAYOUT RAIL panel — the Cashfree Payouts credentials that decide whether the
// weekly statements on this page can be disbursed automatically at all.
//
// It lives on /payouts rather than on /payment-gateway because they are
// different products with different keys: the gateway page configures money
// coming IN, this configures money going OUT. Putting them together would invite
// pasting one product's keys into the other's form, which fails with an
// authentication error that names neither.
//
// The page it sits on still says disbursement is manual. That is what this
// removes — but only once a slot here is configured and verified.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import {
  StatusBadge,
  type Tone,
} from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";

interface PayoutRailStatus {
  configured: boolean;
  slot: string;
  environment: string;
  keyPrefix: string;
  /**
   * Whether this slot can authenticate without a whitelisted source IP.
   *
   * The most operationally important field here. Cashfree Payouts authenticates
   * by source IP unless a signing key is configured, and the platform's egress
   * is a Cloud NAT address that GCP can reallocate — so a slot without signing
   * is one IP change away from silently disbursing nothing.
   */
  signatureConfigured: boolean;
  signingKeyFingerprint?: string;
  clientSecretSet?: boolean;
  webhookSecretSet: boolean;
  slotWarning?: string;
  error: string;
}

interface UpdateResponse {
  message: string;
  verified?: boolean;
  testError?: string;
}

function environmentTone(environment: string, configured: boolean): Tone {
  if (!configured) return "neutral";
  // Production moves real money out of the platform — never a calm green.
  return environment === "production" ? "warning" : "info";
}

function PayoutRailCard({ slot }: { slot: "live" | "test" }) {
  const { data, isLoading, mutate } = useSWR<PayoutRailStatus>(
    ["/payouts/cashfree/status", { mode: slot }],
    swrFetcher,
  );
  const [form, setForm] = useState({
    clientId: "",
    clientSecret: "",
    publicKey: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateResponse | null>(null);
  const { confirm } = useConfirm();

  async function save() {
    setError(null);
    setResult(null);
    const clientId = form.clientId.trim();
    const clientSecret = form.clientSecret.trim();
    const publicKey = form.publicKey.trim();
    if (!clientId && !clientSecret && !publicKey) {
      setError("Enter the fields you want to update — untouched ones keep their stored value.");
      return;
    }
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      setError("Client ID and Client Secret must be replaced together.");
      return;
    }

    const ok = await confirm({
      title: `Update the Cashfree Payouts ${slot} credentials?`,
      message:
        slot === "live"
          ? "Every automatic chef and rider payout from now on is sent from this account. A payout cannot be reversed by the platform — unlike a refund, getting money back means asking the recipient to return it."
          : "Sandbox payouts only. No real money moves through these credentials.",
      confirmLabel: "Replace credentials",
      tone: "destructive",
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await hcAdmin.put<UpdateResponse>("/payouts/cashfree/keys", {
        mode: slot,
        clientId: clientId || undefined,
        clientSecret: clientSecret || undefined,
        publicKey: publicKey || undefined,
      });
      setResult(res);
      // Never keep a secret in component state after it has been sent.
      setForm({ clientId: "", clientSecret: "", publicKey: "" });
      await mutate();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not update the payout credentials.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold">
            Cashfree Payouts — {slot === "live" ? "Live" : "Test"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {slot === "live"
              ? "Sends real money to chefs' and riders' bank accounts."
              : "Sandbox disbursement. Safe to test the full flow end to end."}
          </p>
        </div>
        {isLoading ? null : (
          <StatusBadge
            tone={environmentTone(
              data?.environment ?? "",
              data?.configured ?? false,
            )}
            label={
              !data?.configured
                ? "Not configured"
                : data.environment === "production"
                  ? "PRODUCTION"
                  : "Sandbox"
            }
          />
        )}
      </div>

      {data?.slotWarning ? (
        <div className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {data.slotWarning}
        </div>
      ) : null}

      {data ? (
        <div className="rounded-md border p-3 text-sm">
          <div className="flex items-center justify-between py-1">
            <span className="text-muted-foreground">Client ID</span>
            <span className="font-mono text-xs">{data.keyPrefix || "—"}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-muted-foreground">Client Secret</span>
            <span className="font-mono text-xs">
              {data.clientSecretSet ? "••••••••  on file" : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-muted-foreground">Environment</span>
            <span className="font-mono text-xs">{data.environment || "—"}</span>
          </div>
          {data.signingKeyFingerprint ? (
            <div className="flex items-center justify-between py-1">
              <span className="text-muted-foreground">Signing key</span>
              <span className="font-mono text-xs">{data.signingKeyFingerprint}</span>
            </div>
          ) : null}
          {/* Called out on its own row rather than buried in the warning,
              because it is a standing property of the slot, not an error. */}
          <div className="flex items-center justify-between py-1">
            <span className="text-muted-foreground">Authentication</span>
            <StatusBadge
              tone={data.signatureConfigured ? "success" : "warning"}
              label={
                data.signatureConfigured
                  ? "Signed (no IP dependency)"
                  : "Whitelisted IP only"
              }
            />
          </div>
          {data.error ? (
            <p className="pt-2 text-destructive">{data.error}</p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Client ID</span>
          <input
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.clientId}
            onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            placeholder={
              data?.configured && data.keyPrefix
                ? `On file: ${data.keyPrefix} — type to replace`
                : "CF1234567ABCDEF…"
            }
            autoComplete="off"
          />
          <span className="block text-xs text-muted-foreground">
            From Payouts → Developers → API Keys. Different from your Payment
            Gateway keys.
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Client Secret</span>
          <input
            type="password"
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.clientSecret}
            onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
            placeholder={data?.clientSecretSet ? "•••••••• on file — type to replace" : ""}
            autoComplete="new-password"
          />
        </label>
      </div>

      <label className="space-y-1 text-sm">
        <span className="font-medium">Signing public key (PEM)</span>
        <textarea
          className="h-24 w-full rounded-md border px-3 py-2 font-mono text-xs"
          value={form.publicKey}
          onChange={(e) => setForm({ ...form, publicKey: e.target.value })}
          placeholder={
            data?.signingKeyFingerprint
              ? `On file (${data.signingKeyFingerprint}) — paste a new PEM to replace`
              : "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"
          }
          autoComplete="off"
        />
        <span className="block text-xs text-muted-foreground">
          Strongly recommended. Request one from Cashfree (care@cashfree.com)
          for the Payouts product. Without it this slot authenticates by
          whitelisted IP — and the platform&apos;s outbound IP can change, which
          would stop every payout with no visible error.
        </span>
      </label>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {result ? (
        <p
          className={`text-sm ${result.verified === false ? "text-destructive" : "text-emerald-600"}`}
        >
          {result.message}
          {result.testError ? ` — gateway said: ${result.testError}` : ""}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {saving
          ? "Verifying…"
          : data?.configured
            ? "Save changes"
            : "Save credentials"}
      </button>
    </div>
  );
}

/** Both credential slots, shown above the statement list they govern. */
export function PayoutRailPanel() {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Automatic disbursement</h2>
        <p className="text-sm text-muted-foreground">
          Credentials for the Cashfree Payouts rail. Once a slot is configured
          and verified, statements below can be disbursed to chefs&apos; bank
          accounts instead of being paid by hand and marked off here.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <PayoutRailCard slot="test" />
        <PayoutRailCard slot="live" />
      </div>
    </section>
  );
}
