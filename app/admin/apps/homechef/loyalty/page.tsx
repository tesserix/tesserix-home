"use client";

// HomeChef LOYALTY (#40). Tunes the loyalty.* PlatformSettings block (earn rate,
// redemption, streaks, tiers) and shows the programme's standing liability.
// Migrated from the HomeChef admin-portal into the unified Tesserix admin; the
// Go API owns validation and the points ledger — this only reads/writes config.

import { useEffect, useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import type { LoyaltyAnalytics, LoyaltyConfig } from "@/lib/products/homechef/contracts";

const FIELDS: ReadonlyArray<{
  key: keyof LoyaltyConfig;
  label: string;
  hint: string;
  step?: string;
}> = [
  {
    key: "pointsPerRupee",
    label: "Points per ₹",
    hint: "Earned on the order total.",
    step: "0.01",
  },
  {
    key: "redeemRate",
    label: "₹ per point",
    hint: "Wallet credit each point converts to when redeemed.",
    step: "0.01",
  },
  { key: "minRedeem", label: "Min redeem (points)", hint: "Floor before a customer can convert." },
  { key: "streakThreshold", label: "Streak threshold", hint: "Orders in a row to earn the bonus." },
  { key: "streakBonus", label: "Streak bonus (points)", hint: "Awarded when the streak lands." },
  {
    key: "streakGraceDays",
    label: "Streak grace (days)",
    hint: "Slack before a streak breaks.",
  },
  { key: "tierSilverAt", label: "Silver at (points)", hint: "Lifetime points for Silver." },
  { key: "tierGoldAt", label: "Gold at (points)", hint: "Lifetime points for Gold." },
];

function ConfigCard() {
  const { data, isLoading, mutate } = useSWR<LoyaltyConfig>(["/loyalty/config"], swrFetcher);
  const [form, setForm] = useState<LoyaltyConfig | null>(null);
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
      await hcAdmin.put<LoyaltyConfig>("/loyalty/config", form);
      await mutate();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the loyalty config.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !form) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">Loading config…</div>;
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Programme</h2>
          <p className="text-sm text-muted-foreground">
            Changes apply to points earned from here on — already-earned points keep their value.
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FIELDS.map((f) => (
          <label key={f.key} className="space-y-1 text-sm">
            <span className="font-medium">{f.label}</span>
            <input
              type="number"
              min={0}
              step={f.step ?? "1"}
              className="w-full rounded-md border px-3 py-2"
              value={String(form[f.key] ?? "")}
              onChange={(e) =>
                setForm({ ...form, [f.key]: Number(e.target.value) } as LoyaltyConfig)
              }
            />
            <span className="block text-xs text-muted-foreground">{f.hint}</span>
          </label>
        ))}
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

function AnalyticsCard() {
  const { data, isLoading } = useSWR<LoyaltyAnalytics>(["/loyalty/analytics"], swrFetcher);

  if (isLoading) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">Loading analytics…</div>;
  }
  if (!data) return null;

  const tiles: ReadonlyArray<{ label: string; value: number; hint?: string }> = [
    { label: "Members", value: data.members },
    // Outstanding points are a real liability: every one is wallet credit the
    // platform still owes. Worth reading as money, not a vanity number.
    { label: "Outstanding points", value: data.outstandingPts, hint: "Unredeemed — a liability" },
    { label: "Points earned", value: data.pointsEarned },
    { label: "Points redeemed", value: data.pointsRedeemed },
    { label: "Active streaks", value: data.activeStreaks },
    { label: "Longest streak", value: data.longestStreak },
  ];

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <h2 className="text-base font-semibold">Programme health</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label}>
            <div className="text-2xl font-semibold tabular-nums">{t.value.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">{t.label}</div>
            {t.hint ? <div className="text-[11px] text-muted-foreground/80">{t.hint}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomechefLoyaltyPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Loyalty</h1>
        <p className="text-sm text-muted-foreground">
          Points earned per rupee spent, redeemable as wallet store credit, with streak bonuses and
          tiers.
        </p>
      </div>
      <ConfigCard />
      <AnalyticsCard />
    </div>
  );
}
