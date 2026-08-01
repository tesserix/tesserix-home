"use client";

// HomeChef CHEF REWARDS. Tunes the chef_referral.* / chef_loyalty.* settings —
// the chef-refers-chef cash program (both sides paid via settlement bonus once
// the new kitchen completes its delivered-orders milestone) and the chef
// loyalty points → cashback conversion. The Go API owns validation and the
// bonus ledger; this only reads/writes config and lists redemptions.

import { useEffect, useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";

interface ChefReferralConfig {
  enabled: boolean;
  referrerAmount: number;
  refereeAmount: number;
  milestoneOrders: number;
  monthlySpendCap: number;
}

interface ChefLoyaltyConfig {
  enabled: boolean;
  earnRate: number;
  redeemRate: number;
  minConvertPoints: number;
}

interface ChefRewardsConfig {
  referral: ChefReferralConfig;
  loyalty: ChefLoyaltyConfig;
}

interface ChefReferralRow {
  id: string;
  referrerKitchen: string;
  refereeKitchen: string;
  code: string;
  status: "pending" | "rewarded" | "rejected";
  milestoneOrders: number;
  referrerAmount: number;
  refereeAmount: number;
  createdAt: string;
  rewardedAt?: string;
}

const REFERRAL_FIELDS: ReadonlyArray<{
  key: keyof Omit<ChefReferralConfig, "enabled">;
  label: string;
  hint: string;
}> = [
  { key: "referrerAmount", label: "Referrer reward (₹)", hint: "Cash to the referring kitchen." },
  { key: "refereeAmount", label: "New-chef reward (₹)", hint: "Cash to the onboarded kitchen." },
  {
    key: "milestoneOrders",
    label: "Milestone (orders)",
    hint: "Delivered orders before both rewards vest.",
  },
  {
    key: "monthlySpendCap",
    label: "Monthly cap (₹)",
    hint: "Budget per month; excess referrals stay pending.",
  },
];

const LOYALTY_FIELDS: ReadonlyArray<{
  key: keyof Omit<ChefLoyaltyConfig, "enabled">;
  label: string;
  hint: string;
  step?: string;
}> = [
  { key: "earnRate", label: "Points per ₹", hint: "Earned on delivered-order subtotal.", step: "0.01" },
  { key: "redeemRate", label: "₹ per point", hint: "Cashback each point converts to.", step: "0.01" },
  {
    key: "minConvertPoints",
    label: "Convert threshold (points)",
    hint: "Balance required before conversion.",
  },
];

function ConfigCard() {
  const { data, isLoading, mutate } = useSWR<ChefRewardsConfig>(
    ["/chef-referral/config"],
    swrFetcher,
  );
  const [form, setForm] = useState<ChefRewardsConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await hcAdmin.put<ChefRewardsConfig>("/chef-referral/config", form);
      await mutate();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the chef rewards config.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !form) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">Loading config…</div>;
  }

  return (
    <div className="space-y-6 rounded-lg border p-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Refer a chef</h2>
            <p className="text-sm text-muted-foreground">
              Cash both ways, paid through the weekly settlement once the new kitchen completes its
              milestone. Milestone changes apply to future referrals only.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.referral.enabled}
              onChange={(e) =>
                setForm({ ...form, referral: { ...form.referral, enabled: e.target.checked } })
              }
            />
            Enabled
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {REFERRAL_FIELDS.map((f) => (
            <label key={f.key} className="space-y-1 text-sm">
              <span className="font-medium">{f.label}</span>
              <input
                type="number"
                min={0}
                className="w-full rounded-md border px-3 py-2"
                value={String(form.referral[f.key] ?? "")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    referral: { ...form.referral, [f.key]: Number(e.target.value) },
                  })
                }
              />
              <span className="block text-xs text-muted-foreground">{f.hint}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-4 border-t pt-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Chef loyalty points</h2>
            <p className="text-sm text-muted-foreground">
              Chefs earn points per delivered order and convert the balance into payout cashback
              once past the threshold.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.loyalty.enabled}
              onChange={(e) =>
                setForm({ ...form, loyalty: { ...form.loyalty, enabled: e.target.checked } })
              }
            />
            Enabled
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LOYALTY_FIELDS.map((f) => (
            <label key={f.key} className="space-y-1 text-sm">
              <span className="font-medium">{f.label}</span>
              <input
                type="number"
                min={0}
                step={f.step ?? "1"}
                className="w-full rounded-md border px-3 py-2"
                value={String(form.loyalty[f.key] ?? "")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    loyalty: { ...form.loyalty, [f.key]: Number(e.target.value) },
                  })
                }
              />
              <span className="block text-xs text-muted-foreground">{f.hint}</span>
            </label>
          ))}
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {saved ? <p className="text-sm text-emerald-600">Saved.</p> : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save config"}
      </button>
    </div>
  );
}

const STATUS_BADGE: Record<ChefReferralRow["status"], string> = {
  rewarded: "bg-emerald-100 text-emerald-700",
  pending: "bg-amber-100 text-amber-700",
  rejected: "bg-red-100 text-red-700",
};

function ReferralsCard() {
  const { data, isLoading } = useSWR<{ data: ChefReferralRow[] }>(
    ["/chef-referrals"],
    swrFetcher,
  );

  if (isLoading) {
    return (
      <div className="rounded-lg border p-6 text-sm text-muted-foreground">Loading referrals…</div>
    );
  }
  const rows = data?.data ?? [];

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <h2 className="text-base font-semibold">Kitchen referrals</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No referrals yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-4">Referrer</th>
                <th className="py-2 pr-4">New kitchen</th>
                <th className="py-2 pr-4">Code</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Rewards</th>
                <th className="py-2">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{r.referrerKitchen || "—"}</td>
                  <td className="py-2 pr-4">{r.refereeKitchen || "—"}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.code}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {r.status === "rewarded"
                      ? `₹${r.referrerAmount} / ₹${r.refereeAmount}`
                      : `${r.milestoneOrders}-order milestone`}
                  </td>
                  <td className="py-2 tabular-nums">
                    {new Date(r.createdAt).toLocaleDateString("en-IN")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function HomechefChefRewardsPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Chef Rewards</h1>
        <p className="text-sm text-muted-foreground">
          The chef referral program and per-order chef loyalty points, both settled as cash on the
          weekly payout.
        </p>
      </div>
      <ConfigCard />
      <ReferralsCard />
    </div>
  );
}
