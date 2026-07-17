"use client";

// HomeChef PLATFORM SETTINGS. The PlatformSettings blocks that decide the
// economics of every order: fees and payout splits, subscription pricing, and
// the referral rewards. Migrated from the HomeChef admin-portal into the
// unified Tesserix admin.
//
// These are runtime-tunable by design (no deploy) — which also means a typo
// re-prices the platform the moment it is saved. Each section therefore saves on
// its own and states what its numbers actually move, rather than presenting one
// undifferentiated wall of inputs.
//
// The personal half of the portal's settings bundle (/profile, /security/*,
// /notifications/preferences) is deliberately NOT here: that is the operator's
// own account, and tesserix-home already owns identity.

import { useEffect, useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type {
  PlatformPolicy,
  ReferralConfig,
  SubscriptionPricing,
} from "@/lib/products/homechef/contracts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function Field({
  label,
  hint,
  value,
  onChange,
  type = "number",
  step,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  step?: string;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type={type}
        step={step}
        min={type === "number" ? 0 : undefined}
        className="w-full rounded-md border px-3 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function PolicySection() {
  const { data, isLoading, mutate } = useSWR<PlatformPolicy>(["/platform/policy"], swrFetcher);
  const [form, setForm] = useState<PlatformPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { confirm } = useConfirm();

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save() {
    if (!form) return;
    // The split is the part worth a second look: these two decide who gets what
    // out of every order, and they take effect immediately.
    const ok = await confirm({
      title: "Save platform policy?",
      message: `Service fee ${form.serviceFeePercent}% and chef payout ${form.chefPayoutPercent}% apply to every new order from the moment you save.`,
      confirmLabel: "Save policy",
    });
    if (!ok) return;

    setSaving(true);
    setMsg(null);
    try {
      await hcAdmin.put<PlatformPolicy>("/platform/policy", form);
      await mutate();
      setMsg({ ok: true, text: "Policy saved." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save the policy." });
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(idx: number) {
    if (!form) return;
    const days = form.operatingDays.includes(idx)
      ? form.operatingDays.filter((d) => d !== idx)
      : [...form.operatingDays, idx].sort((a, b) => a - b);
    setForm({ ...form, operatingDays: days });
  }

  if (isLoading || !form) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">Loading policy…</div>;
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div>
        <h2 className="text-base font-semibold">Fees &amp; payouts</h2>
        <p className="text-sm text-muted-foreground">
          Applies to every new order. Orders already placed keep the economics they were priced with.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Service fee %"
          hint="Platform's cut, charged to the customer."
          step="0.01"
          value={String(form.serviceFeePercent)}
          onChange={(v) => setForm({ ...form, serviceFeePercent: Number(v) })}
        />
        <Field
          label="Tax %"
          step="0.01"
          value={String(form.taxPercent)}
          onChange={(v) => setForm({ ...form, taxPercent: Number(v) })}
        />
        <Field
          label="Chef payout %"
          hint="Share of the order that reaches the chef."
          step="0.01"
          value={String(form.chefPayoutPercent)}
          onChange={(v) => setForm({ ...form, chefPayoutPercent: Number(v) })}
        />
        <Field
          label="Driver payout %"
          step="0.01"
          value={String(form.driverPayoutPercent)}
          onChange={(v) => setForm({ ...form, driverPayoutPercent: Number(v) })}
        />
        <Field
          label="Base delivery fee ₹"
          step="0.01"
          value={String(form.baseDeliveryFee)}
          onChange={(v) => setForm({ ...form, baseDeliveryFee: Number(v) })}
        />
        <Field
          label="Per-km delivery fee ₹"
          step="0.01"
          value={String(form.perKmDeliveryFee)}
          onChange={(v) => setForm({ ...form, perKmDeliveryFee: Number(v) })}
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold">Trading hours</h3>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <Field
            label="Opens"
            type="time"
            value={form.openingTime}
            onChange={(v) => setForm({ ...form, openingTime: v })}
          />
          <Field
            label="Closes"
            type="time"
            value={form.closingTime}
            onChange={(v) => setForm({ ...form, closingTime: v })}
          />
          <Field
            label="Timezone"
            type="text"
            value={form.timezone}
            onChange={(v) => setForm({ ...form, timezone: v })}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {WEEKDAYS.map((d, i) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(i)}
              className={`rounded-md px-3 py-1 text-xs ${
                form.operatingDays.includes(i)
                  ? "bg-primary text-primary-foreground"
                  : "border text-muted-foreground"
              }`}
            >
              {d}
            </button>
          ))}
        </div>

        <label className="mt-3 block space-y-1 text-sm">
          <span className="font-medium">Closed message</span>
          <input
            className="w-full rounded-md border px-3 py-2"
            value={form.closedMessage}
            onChange={(e) => setForm({ ...form, closedMessage: e.target.value })}
          />
          <span className="block text-xs text-muted-foreground">
            What customers see outside trading hours.
          </span>
        </label>
      </div>

      {msg ? (
        <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-destructive"}`}>{msg.text}</p>
      ) : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save policy"}
      </button>
    </div>
  );
}

function SubscriptionPricingSection() {
  const { data, isLoading, mutate } = useSWR<SubscriptionPricing>(
    ["/subscription-pricing"],
    swrFetcher,
  );
  const [form, setForm] = useState<SubscriptionPricing | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setMsg(null);
    try {
      await hcAdmin.put<SubscriptionPricing>("/subscription-pricing", form);
      await mutate();
      setMsg({ ok: true, text: "Pricing saved." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save pricing." });
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !form) return null;

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div>
        <h2 className="text-base font-semibold">Chef subscription pricing</h2>
        <p className="text-sm text-muted-foreground">
          What a chef pays to be on the platform. Premium also lowers their commission.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Trial days"
          value={String(form.trialDays)}
          onChange={(v) => setForm({ ...form, trialDays: Number(v) })}
        />
        <Field
          label="Min earnings before billing ₹"
          hint="A chef under this isn't charged."
          value={String(form.minEarningsThreshold)}
          onChange={(v) => setForm({ ...form, minEarningsThreshold: Number(v) })}
        />
        <Field
          label="Premium commission rate %"
          step="0.01"
          value={String(form.premiumCommissionRate)}
          onChange={(v) => setForm({ ...form, premiumCommissionRate: Number(v) })}
        />
      </div>

      {(["standard", "premium"] as const).map((tier) => (
        <div key={tier}>
          <h3 className="text-sm font-semibold capitalize">{tier}</h3>
          <div className="mt-2 grid gap-4 sm:grid-cols-3">
            {(["monthly", "quarterly", "yearly"] as const).map((period) => (
              <Field
                key={period}
                label={`${period} ₹`}
                value={String(form[tier][period])}
                onChange={(v) =>
                  setForm({ ...form, [tier]: { ...form[tier], [period]: Number(v) } })
                }
              />
            ))}
          </div>
        </div>
      ))}

      {msg ? (
        <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-destructive"}`}>{msg.text}</p>
      ) : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save pricing"}
      </button>
    </div>
  );
}

function ReferralSection() {
  const { data, isLoading, mutate } = useSWR<ReferralConfig>(["/referral/config"], swrFetcher);
  const [form, setForm] = useState<ReferralConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setMsg(null);
    try {
      await hcAdmin.put<ReferralConfig>("/referral/config", form);
      await mutate();
      setMsg({ ok: true, text: "Referral config saved." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !form) return null;

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Referrals</h2>
          <p className="text-sm text-muted-foreground">
            Both rewards are paid by the platform, so the monthly cap is the real exposure control.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Referrer reward ₹"
          value={String(form.referrerReward)}
          onChange={(v) => setForm({ ...form, referrerReward: Number(v) })}
        />
        <Field
          label="Referee reward ₹"
          value={String(form.refereeReward)}
          onChange={(v) => setForm({ ...form, refereeReward: Number(v) })}
        />
        <Field
          label="Monthly spend cap ₹"
          hint="Total the programme may pay out in a month."
          value={String(form.monthlySpendCap)}
          onChange={(v) => setForm({ ...form, monthlySpendCap: Number(v) })}
        />
      </div>

      {msg ? (
        <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-destructive"}`}>{msg.text}</p>
      ) : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save referrals"}
      </button>
    </div>
  );
}

export default function HomechefPlatformSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Platform settings</h1>
        <p className="text-sm text-muted-foreground">
          Fees, payout splits, subscription pricing and referral rewards. Every value here is live —
          saving re-prices the platform immediately.
        </p>
      </div>
      <PolicySection />
      <SubscriptionPricingSection />
      <ReferralSection />
    </div>
  );
}
