"use client";

// HomeChef PROMOS (#39). Discount codes: create, list, deactivate/delete, and
// watch each code's budget burn. Migrated from the HomeChef admin-portal into
// the unified Tesserix admin.
//
// fundingSource is the money decision on this screen: "platform" absorbs the
// discount, "chef" deducts it from that chef's payout. A chef-funded promo
// therefore REQUIRES a chef, and the form enforces that before it will submit —
// a chef-funded code with no chef would silently bill the platform instead.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatINR, formatDateTime } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type {
  ChefWithStats,
  Paginated,
  Promo,
  PromoDiscountType,
  PromoFundingSource,
} from "@/lib/products/homechef/contracts";

interface PromoForm {
  code: string;
  description: string;
  discountType: PromoDiscountType;
  discountValue: string;
  minOrderAmount: string;
  maxDiscount: string;
  usageLimit: string;
  perUserLimit: string;
  validUntil: string;
  fundingSource: PromoFundingSource;
  chefId: string;
  budgetCap: string;
}

const EMPTY: PromoForm = {
  code: "",
  description: "",
  discountType: "percentage",
  discountValue: "",
  minOrderAmount: "0",
  maxDiscount: "0",
  usageLimit: "0",
  perUserLimit: "1",
  validUntil: "",
  fundingSource: "platform",
  chefId: "",
  budgetCap: "0",
};

function promoTone(p: Promo): Tone {
  if (!p.isActive) return "neutral";
  if (p.budgetCap > 0 && p.budgetSpent >= p.budgetCap) return "danger";
  if (p.usageLimit > 0 && p.usageCount >= p.usageLimit) return "danger";
  return "success";
}

function promoState(p: Promo): string {
  if (!p.isActive) return "Inactive";
  if (p.budgetCap > 0 && p.budgetSpent >= p.budgetCap) return "Budget spent";
  if (p.usageLimit > 0 && p.usageCount >= p.usageLimit) return "Limit reached";
  return "Active";
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState<PromoForm>(EMPTY);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only needed for chef-funded codes; loaded lazily when that's chosen.
  const { data: chefs } = useSWR<Paginated<ChefWithStats>>(
    form.fundingSource === "chef" ? ["/chefs", { page: 1, limit: 200 }] : null,
    swrFetcher,
  );

  function set<K extends keyof PromoForm>(k: K, v: PromoForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit() {
    setError(null);
    if (!form.code.trim()) return setError("A code is required.");
    if (Number(form.discountValue) <= 0) return setError("Discount must be greater than zero.");
    // The money guard: chef-funded means a chef's payout is debited, so we must
    // know whose. Without this the API would fall back to platform-funded.
    if (form.fundingSource === "chef" && !form.chefId) {
      return setError("Pick the chef whose payout funds this code.");
    }

    setSaving(true);
    try {
      await hcAdmin.post("/promos", {
        code: form.code.trim().toUpperCase(),
        description: form.description.trim(),
        discountType: form.discountType,
        discountValue: Number(form.discountValue),
        minOrderAmount: Number(form.minOrderAmount),
        maxDiscount: Number(form.maxDiscount),
        usageLimit: Number(form.usageLimit),
        perUserLimit: Number(form.perUserLimit),
        validUntil: form.validUntil || undefined,
        fundingSource: form.fundingSource,
        chefId: form.fundingSource === "chef" ? form.chefId : undefined,
        budgetCap: Number(form.budgetCap),
      });
      setForm(EMPTY);
      setOpen(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the promo.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        New promo
      </button>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <h2 className="text-base font-semibold">New promo</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Code</span>
          <input
            className="w-full rounded-md border px-3 py-2 uppercase"
            value={form.code}
            onChange={(e) => set("code", e.target.value)}
            placeholder="WELCOME50"
          />
        </label>

        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Description</span>
          <input
            className="w-full rounded-md border px-3 py-2"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Type</span>
          <select
            className="w-full rounded-md border px-3 py-2"
            value={form.discountType}
            onChange={(e) => set("discountType", e.target.value as PromoDiscountType)}
          >
            <option value="percentage">Percentage</option>
            <option value="fixed">Fixed ₹</option>
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">
            {form.discountType === "percentage" ? "Discount %" : "Discount ₹"}
          </span>
          <input
            type="number"
            min={0}
            className="w-full rounded-md border px-3 py-2"
            value={form.discountValue}
            onChange={(e) => set("discountValue", e.target.value)}
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Max discount ₹</span>
          <input
            type="number"
            min={0}
            className="w-full rounded-md border px-3 py-2"
            value={form.maxDiscount}
            onChange={(e) => set("maxDiscount", e.target.value)}
          />
          <span className="block text-xs text-muted-foreground">0 = uncapped.</span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Min order ₹</span>
          <input
            type="number"
            min={0}
            className="w-full rounded-md border px-3 py-2"
            value={form.minOrderAmount}
            onChange={(e) => set("minOrderAmount", e.target.value)}
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Total uses</span>
          <input
            type="number"
            min={0}
            className="w-full rounded-md border px-3 py-2"
            value={form.usageLimit}
            onChange={(e) => set("usageLimit", e.target.value)}
          />
          <span className="block text-xs text-muted-foreground">0 = unlimited.</span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Per customer</span>
          <input
            type="number"
            min={1}
            className="w-full rounded-md border px-3 py-2"
            value={form.perUserLimit}
            onChange={(e) => set("perUserLimit", e.target.value)}
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Valid until</span>
          <input
            type="date"
            className="w-full rounded-md border px-3 py-2"
            value={form.validUntil}
            onChange={(e) => set("validUntil", e.target.value)}
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Funded by</span>
          <select
            className="w-full rounded-md border px-3 py-2"
            value={form.fundingSource}
            onChange={(e) => set("fundingSource", e.target.value as PromoFundingSource)}
          >
            <option value="platform">Platform</option>
            <option value="chef">Chef</option>
          </select>
          <span className="block text-xs text-muted-foreground">
            {form.fundingSource === "chef"
              ? "Deducted from the chef's payout."
              : "The platform absorbs the discount."}
          </span>
        </label>

        {form.fundingSource === "chef" ? (
          <label className="space-y-1 text-sm">
            <span className="font-medium">Chef</span>
            <select
              className="w-full rounded-md border px-3 py-2"
              value={form.chefId}
              onChange={(e) => set("chefId", e.target.value)}
            >
              <option value="">Select a chef…</option>
              {(chefs?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.businessName}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="space-y-1 text-sm">
          <span className="font-medium">Budget cap ₹</span>
          <input
            type="number"
            min={0}
            className="w-full rounded-md border px-3 py-2"
            value={form.budgetCap}
            onChange={(e) => set("budgetCap", e.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            Total discount this code may ever give. 0 = uncapped.
          </span>
        </label>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {saving ? "Creating…" : "Create promo"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-md border px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function HomechefPromosPage() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  const { data, isLoading, mutate } = useSWR<{ data: Promo[] }>(["/promos"], swrFetcher);
  const promos = data?.data ?? [];

  async function remove(p: Promo) {
    const ok = await confirm({
      title: `Delete ${p.code}?`,
      message:
        "The code stops working immediately. Orders already placed with it are unaffected.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
    if (!ok) return;

    setBusyId(p.id);
    setError(null);
    try {
      await hcAdmin.delete(`/promos/${p.id}`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the promo.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Promos</h1>
        <p className="text-sm text-muted-foreground">
          Discount codes. Chef-funded codes come out of that chef&apos;s payout; platform-funded ones
          come out of margin.
        </p>
      </div>

      <CreateForm onCreated={() => void mutate()} />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : promos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No promos yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="p-3">Code</th>
                <th className="p-3">Discount</th>
                <th className="p-3">Funded by</th>
                <th className="p-3 text-right">Used</th>
                <th className="p-3 text-right">Budget</th>
                <th className="p-3">Expires</th>
                <th className="p-3">State</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="p-3">
                    <div className="font-mono font-medium">{p.code}</div>
                    {p.description ? (
                      <div className="text-xs text-muted-foreground">{p.description}</div>
                    ) : null}
                  </td>
                  <td className="p-3 tabular-nums">
                    {p.discountType === "percentage"
                      ? `${p.discountValue}%`
                      : formatINR(p.discountValue)}
                    {p.maxDiscount > 0 && p.discountType === "percentage" ? (
                      <span className="text-xs text-muted-foreground">
                        {" "}
                        (max {formatINR(p.maxDiscount)})
                      </span>
                    ) : null}
                  </td>
                  <td className="p-3">
                    {p.fundingSource === "chef" ? "Chef" : "Platform"}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {p.usageCount}
                    {p.usageLimit > 0 ? ` / ${p.usageLimit}` : ""}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {p.budgetCap > 0
                      ? `${formatINR(p.budgetSpent)} / ${formatINR(p.budgetCap)}`
                      : formatINR(p.budgetSpent)}
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    {p.validUntil ? formatDateTime(p.validUntil) : "—"}
                  </td>
                  <td className="p-3">
                    <StatusBadge tone={promoTone(p)} label={promoState(p)} />
                  </td>
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() => void remove(p)}
                      disabled={busyId === p.id}
                      className="rounded-md border px-3 py-1 text-xs disabled:opacity-60"
                    >
                      Delete
                    </button>
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
