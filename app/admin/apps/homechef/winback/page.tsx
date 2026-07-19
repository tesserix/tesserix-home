"use client";

// HomeChef WIN-BACK OFFERS (#42). Tunes the auto-offer policy (the winback.*
// PlatformSettings block) and shows the reactivation analytics behind it.
// Migrated from the HomeChef admin-portal so every HomeChef operator surface
// lives here; the money/policy seams stay server-side — this only reads and
// writes the settings the Go API already validates.

import { useEffect, useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import {
  WINBACK_TRIGGER_LABEL,
  type WinbackAnalytics,
  type WinbackConfig,
} from "@/lib/products/homechef/contracts";

const PERCENT_FIELDS: ReadonlyArray<{
  key: keyof WinbackConfig;
  label: string;
  hint: string;
  min: number;
  max: number;
}> = [
  {
    key: "discountPercent",
    label: "Discount %",
    hint: "Percent off the next order.",
    min: 1,
    max: 100,
  },
  {
    key: "maxDiscount",
    label: "Max discount (₹)",
    hint: "Caps the rupee value however large the order.",
    min: 1,
    max: 100000,
  },
  {
    key: "validityDays",
    label: "Valid for (days)",
    hint: "How long the offer stays redeemable.",
    min: 1,
    max: 365,
  },
  {
    key: "lapseThresholdDays",
    label: "Lapse after (days)",
    hint: "Days of silence before a customer counts as lapsed.",
    min: 1,
    max: 365,
  },
  {
    key: "cooldownDays",
    label: "Cooldown (days)",
    hint: "Minimum gap before the same customer is offered again.",
    min: 1,
    max: 365,
  },
];

function ConfigCard() {
  const { data, isLoading, mutate } = useSWR<WinbackConfig>(["/winback/config"], swrFetcher);
  const [form, setForm] = useState<WinbackConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the form once the server value lands. Keyed on `data` so a refetch
  // after save re-syncs rather than leaving the form drifting from the server.
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await hcAdmin.put<WinbackConfig>("/winback/config", form);
      await mutate();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the win-back policy.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !form) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">Loading policy…</div>;
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Offer policy</h2>
          <p className="text-sm text-muted-foreground">
            Applies to every new win-back offer. Existing offers keep the terms they were issued with.
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

      <div className="grid gap-4 sm:grid-cols-2">
        {PERCENT_FIELDS.map((f) => (
          <label key={f.key} className="space-y-1 text-sm">
            <span className="font-medium">{f.label}</span>
            <input
              type="number"
              min={f.min}
              max={f.max}
              className="w-full rounded-md border px-3 py-2"
              value={String(form[f.key] ?? "")}
              onChange={(e) =>
                setForm({ ...form, [f.key]: Number(e.target.value) } as WinbackConfig)
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
        {saving ? "Saving…" : "Save policy"}
      </button>
    </div>
  );
}

function AnalyticsCard() {
  const { data, isLoading } = useSWR<WinbackAnalytics>(["/winback/analytics"], swrFetcher);

  if (isLoading) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">Loading analytics…</div>;
  }
  if (!data) return null;

  const tiles: ReadonlyArray<{ label: string; value: string }> = [
    { label: "Offers", value: String(data.total) },
    { label: "Delivered", value: String(data.offered) },
    { label: "Reactivated", value: String(data.reactivated) },
    { label: "Expired", value: String(data.expired) },
    // Server already returns a percentage (reactivated/resolved*100).
    { label: "Reactivation rate", value: `${data.reactivationRate.toFixed(1)}%` },
  ];

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <h2 className="text-base font-semibold">Reactivation</h2>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label}>
            <div className="text-2xl font-semibold tabular-nums">{t.value}</div>
            <div className="text-xs text-muted-foreground">{t.label}</div>
          </div>
        ))}
      </div>

      {/* A nil Go slice serialises to null — byTrigger is `var byTrigger
          []triggerRow` and stays nil when no offers exist yet, so guard before
          reading it or the page dies on a fresh platform. */}
      {(data.byTrigger ?? []).length > 0 ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">Trigger</th>
              <th className="py-2 text-right">Offers</th>
              <th className="py-2 text-right">Reactivated</th>
              <th className="py-2 text-right">Rate</th>
            </tr>
          </thead>
          <tbody>
            {(data.byTrigger ?? []).map((row) => (
              <tr key={row.trigger} className="border-b last:border-0">
                <td className="py-2">{WINBACK_TRIGGER_LABEL[row.trigger] ?? row.trigger}</td>
                <td className="py-2 text-right tabular-nums">{row.total}</td>
                <td className="py-2 text-right tabular-nums">{row.reactivated}</td>
                <td className="py-2 text-right tabular-nums">
                  {row.total > 0 ? `${((row.reactivated / row.total) * 100).toFixed(1)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted-foreground">No offers issued yet.</p>
      )}
    </div>
  );
}

export default function HomechefWinbackPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Win-back offers</h1>
        <p className="text-sm text-muted-foreground">
          Auto-offers a discounted promo when a customer lapses or a subscriber cancels or suspends —
          delivered by push and email — to protect order and subscription LTV.
        </p>
      </div>
      <ConfigCard />
      <AnalyticsCard />
    </div>
  );
}
