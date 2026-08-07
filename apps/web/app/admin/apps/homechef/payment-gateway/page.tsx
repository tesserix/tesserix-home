"use client";

// HomeChef PAYMENT GATEWAY (#262). The live Cashfree / Stripe credentials the
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
  CashfreeGatewayStatus,
  StripeGatewayStatus,
  UpdateKeysResponse,
} from "@tesserix/homechef-shared";

function modeTone(mode: string, configured: boolean): Tone {
  if (!configured) return "neutral";
  // Live keys move real money — never render that as a calm "success" green.
  return mode === "live" ? "warning" : "info";
}

/**
 * Flags a credential slot holding a key of the wrong kind.
 *
 * Deliberately a warning rather than a blocked save: the Live slot legitimately
 * holds a test key until a real live key is issued, and refusing to save that
 * would make the interim state unreachable.
 */
function SlotWarning({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {text}
    </div>
  );
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <StatusBadge tone={ok ? "success" : "danger"} label={ok ? "Set" : "Missing"} />
    </div>
  );
}

function CashfreeCard({ slot }: { slot: "live" | "test" }) {
  const { data, isLoading, mutate } = useSWR<CashfreeGatewayStatus>(
    ["/payment-gateway/cashfree/status", { mode: slot }],
    swrFetcher,
  );
  const [form, setForm] = useState({ appId: "", secretKey: "", webhookSecret: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateKeysResponse | null>(null);
  const { confirm } = useConfirm();

  async function save() {
    setError(null);
    setResult(null);
    if (!form.appId.trim() || !form.secretKey.trim()) {
      setError("Both the App ID and Secret Key are required.");
      return;
    }

    // Cashfree sandbox App IDs are prefixed "TEST". A mismatch here does NOT
    // degrade gracefully: Cashfree separates environments by host, so test
    // credentials in the Live slot are a permanent 401 against api.cashfree.com,
    // not a "captures nothing" state. Say so at the moment the admin decides,
    // rather than leaving them to find it in a banner later.
    const keyKind = form.appId.trim().toUpperCase().startsWith("TEST") ? "test" : "live";
    const mismatch = keyKind !== slot;
    const ok = await confirm({
      title: `Replace the Cashfree ${slot} credentials?`,
      message:
        (mismatch
          ? `Heads up: this looks like a ${keyKind.toUpperCase()} App ID going into the ${slot.toUpperCase()} slot. ` +
            (slot === "live"
              ? "Cashfree splits sandbox and production by host, so live payments will fail with 401 until real live credentials are entered — checkout has no other rail to fall back to. "
              : "Sandbox orders would charge real cards. ")
          : "") +
        "Every Cashfree payment and refund from now on uses this merchant account. Refunds are issued against the ORDER, so orders taken on the previous account can no longer be refunded through this one — check for in-flight refunds before saving.",
      confirmLabel: "Replace credentials",
      tone: "destructive",
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await hcAdmin.put<UpdateKeysResponse>("/payment-gateway/cashfree/keys", {
        mode: slot,
        appId: form.appId.trim(),
        secretKey: form.secretKey.trim(),
        webhookSecret: form.webhookSecret.trim() || undefined,
      });
      setResult(res);
      // Never keep a secret in component state after it has been sent.
      setForm({ appId: "", secretKey: "", webhookSecret: "" });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the Cashfree credentials.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold">
            Cashfree — {slot === "live" ? "Live" : "Test"} credentials
          </h2>
          <p className="text-sm text-muted-foreground">
            {slot === "live"
              ? "The preferred gateway for new kitchens. Real money moves through these credentials."
              : "Used only by kitchens marked as Test. No real money moves through these credentials."}
          </p>
        </div>
        {isLoading ? null : (
          <StatusBadge
            tone={modeTone(data?.environment === "production" ? "live" : "", data?.configured ?? false)}
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

      <SlotWarning text={data?.slotWarning} />

      {data ? (
        <div className="rounded-md border p-3">
          <StatusRow label="Secret key" ok={data.configured} />
          <StatusRow label="Webhook secret" ok={data.webhookSecretSet} />
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-muted-foreground">App ID</span>
            <span className="font-mono text-xs">{data.keyPrefix || "—"}</span>
          </div>
          {/* Which host this slot resolves to is the load-bearing fact for
              Cashfree — it, not the key, decides whether real money can move. */}
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-muted-foreground">Environment</span>
            <span className="font-mono text-xs">{data.environment || "—"}</span>
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
          <span className="font-medium">App ID</span>
          <input
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.appId}
            onChange={(e) => setForm({ ...form, appId: e.target.value })}
            placeholder="TEST… / your live App ID"
            autoComplete="off"
          />
          <span className="block text-xs text-muted-foreground">
            Cashfree calls this the App ID (sent as x-client-id).
          </span>
        </label>
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
          <span className="font-medium">Webhook secret</span>
          <input
            type="password"
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={form.webhookSecret}
            onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
            autoComplete="new-password"
          />
          <span className="block text-xs text-muted-foreground">
            Must match the secret on the webhook endpoint in the Cashfree dashboard, or every webhook
            fails signature verification. Set it per environment — sandbox and production sign with
            different secrets.
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
        {saving ? "Verifying…" : "Replace credentials"}
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
            Secondary gateway. Unconfigured is fine — the API degrades to Cashfree-only.
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
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Payment gateway</h1>
        <p className="text-sm text-muted-foreground">
          The credentials HomeChef charges and refunds on. Replacing them re-points every payment —
          if the new keys belong to a different merchant account, chef payout links and your webhook
          stop resolving.
        </p>
      </div>
      <CashfreeCard slot="live" />
      <CashfreeCard slot="test" />
      <StripeCard />
    </div>
  );
}
