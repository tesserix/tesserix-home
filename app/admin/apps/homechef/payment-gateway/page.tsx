"use client";

// HomeChef PAYMENT GATEWAY (#262). The live Razorpay / Stripe credentials the
// platform charges with. Migrated from the HomeChef admin-portal into the
// unified Tesserix admin.
//
// This is the most destructive screen in the HomeChef admin: saving new keys
// re-points every payment AND every refund at a different merchant account. The
// 2026-07-17 key swap is the worked example — the new test key belonged to a
// different merchant, so the previous merchant's Route linked accounts (chef
// payouts) and its webhook stopped resolving, silently. The copy below says so,
// because nothing in the form itself would tell you.
//
// The API never returns a secret — status carries only keyPrefix and whether
// each secret is set — and this screen never echoes one back.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type {
  PaymentGatewayStatus,
  StripeGatewayStatus,
  UpdateKeysResponse,
} from "@/lib/products/homechef/contracts";

function modeTone(mode: string, configured: boolean): Tone {
  if (!configured) return "neutral";
  // Live keys move real money — never render that as a calm "success" green.
  return mode === "live" ? "warning" : "info";
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <StatusBadge tone={ok ? "success" : "danger"} label={ok ? "Set" : "Missing"} />
    </div>
  );
}

function RazorpayCard() {
  const { data, isLoading, mutate } = useSWR<PaymentGatewayStatus>(
    ["/payment-gateway/status"],
    swrFetcher,
  );
  const [form, setForm] = useState({ keyId: "", keySecret: "", webhookSecret: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateKeysResponse | null>(null);
  const { confirm } = useConfirm();

  async function save() {
    setError(null);
    setResult(null);
    if (!form.keyId.trim() || !form.keySecret.trim()) {
      setError("Both the key id and key secret are required.");
      return;
    }

    const nextMode = form.keyId.startsWith("rzp_live_") ? "live" : "test";
    const ok = await confirm({
      title: `Replace the Razorpay ${nextMode} keys?`,
      message:
        "Every payment and refund from now on uses this merchant account. If it is a different account, existing chef payout links (Route linked accounts) and your webhook will stop resolving — silently. Re-check the webhook and chef payouts after saving.",
      confirmLabel: "Replace keys",
      tone: "destructive",
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await hcAdmin.put<UpdateKeysResponse>("/payment-gateway/keys", {
        keyId: form.keyId.trim(),
        keySecret: form.keySecret.trim(),
        webhookSecret: form.webhookSecret.trim() || undefined,
      });
      setResult(res);
      // Never keep a secret in component state after it has been sent.
      setForm({ keyId: "", keySecret: "", webhookSecret: "" });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the Razorpay keys.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold">Razorpay</h2>
          <p className="text-sm text-muted-foreground">The gateway HomeChef charges and refunds on.</p>
        </div>
        {isLoading ? null : (
          <StatusBadge
            tone={modeTone(data?.mode ?? "", data?.configured ?? false)}
            label={
              !data?.configured ? "Not configured" : data.mode === "live" ? "LIVE" : "Test mode"
            }
          />
        )}
      </div>

      {data ? (
        <div className="rounded-md border p-3">
          <StatusRow label="Key secret" ok={data.configured} />
          <StatusRow label="Webhook secret" ok={data.webhookSecretSet} />
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-muted-foreground">Key prefix</span>
            <span className="font-mono text-xs">{data.keyPrefix || "—"}</span>
          </div>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-muted-foreground">Webhook URL</span>
            <span className="font-mono text-xs">{data.webhookUrl || "—"}</span>
          </div>
          {data.error ? <p className="pt-2 text-sm text-destructive">{data.error}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Key ID</span>
          <input
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.keyId}
            onChange={(e) => setForm({ ...form, keyId: e.target.value })}
            placeholder="rzp_test_… / rzp_live_…"
            autoComplete="off"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Key secret</span>
          <input
            type="password"
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.keySecret}
            onChange={(e) => setForm({ ...form, keySecret: e.target.value })}
            autoComplete="new-password"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Webhook secret</span>
          <input
            type="password"
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.webhookSecret}
            onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
            autoComplete="new-password"
          />
          <span className="block text-xs text-muted-foreground">
            Must match the secret set on the webhook in the Razorpay dashboard, or every webhook
            fails signature verification.
          </span>
        </label>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {result ? (
        <p className={`text-sm ${result.verified === false ? "text-destructive" : "text-emerald-600"}`}>
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
        {saving ? "Verifying…" : "Replace keys"}
      </button>
    </div>
  );
}

function StripeCard() {
  const { data, isLoading, mutate } = useSWR<StripeGatewayStatus>(
    ["/payment-gateway/stripe/status"],
    swrFetcher,
  );
  const [form, setForm] = useState({ secretKey: "", publishableKey: "", webhookSecret: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateKeysResponse | null>(null);
  const { confirm } = useConfirm();

  async function save() {
    setError(null);
    setResult(null);
    if (!form.secretKey.trim()) {
      setError("The secret key is required.");
      return;
    }
    const ok = await confirm({
      title: "Replace the Stripe keys?",
      message: "Every Stripe payment and refund from now on uses this account.",
      confirmLabel: "Replace keys",
      tone: "destructive",
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await hcAdmin.put<UpdateKeysResponse>("/payment-gateway/stripe/keys", {
        secretKey: form.secretKey.trim(),
        publishableKey: form.publishableKey.trim() || undefined,
        webhookSecret: form.webhookSecret.trim() || undefined,
      });
      setResult(res);
      setForm({ secretKey: "", publishableKey: "", webhookSecret: "" });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the Stripe keys.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold">Stripe</h2>
          <p className="text-sm text-muted-foreground">
            Secondary gateway. Unconfigured is fine — the API degrades to Razorpay-only.
          </p>
        </div>
        {isLoading ? null : (
          <StatusBadge
            tone={modeTone(data?.mode ?? "", data?.configured ?? false)}
            label={
              !data?.configured ? "Not configured" : data.mode === "live" ? "LIVE" : "Test mode"
            }
          />
        )}
      </div>

      {data?.configured ? (
        <div className="rounded-md border p-3">
          <StatusRow label="Secret key" ok={data.configured} />
          <StatusRow label="Publishable key" ok={data.publishableKeySet} />
          <StatusRow label="Webhook secret" ok={data.webhookSecretSet} />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Secret key</span>
          <input
            type="password"
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.secretKey}
            onChange={(e) => setForm({ ...form, secretKey: e.target.value })}
            autoComplete="new-password"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Publishable key</span>
          <input
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.publishableKey}
            onChange={(e) => setForm({ ...form, publishableKey: e.target.value })}
            autoComplete="off"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Webhook secret</span>
          <input
            type="password"
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.webhookSecret}
            onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
            autoComplete="new-password"
          />
        </label>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {result ? (
        <p className={`text-sm ${result.verified === false ? "text-destructive" : "text-emerald-600"}`}>
          {result.message}
          {result.testError ? ` — gateway said: ${result.testError}` : ""}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {saving ? "Verifying…" : "Replace keys"}
      </button>
    </div>
  );
}

export default function HomechefPaymentGatewayPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Payment gateway</h1>
        <p className="text-sm text-muted-foreground">
          The credentials HomeChef charges and refunds on. Replacing them re-points every payment —
          if the new keys belong to a different merchant account, chef payout links and your webhook
          stop resolving.
        </p>
      </div>
      <RazorpayCard />
      <StripeCard />
    </div>
  );
}
