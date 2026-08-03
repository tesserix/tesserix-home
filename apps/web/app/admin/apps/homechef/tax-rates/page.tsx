"use client";

// HomeChef TAX RATES — the source of truth for what every supply on an order is
// taxed at, and a sandbox for seeing what a change does before it is saved.
//
// One bill carries several rates: the food is restaurant service, the platform
// fee is the platform's own service, and delivery depends on WHO carries it.
// Every money path in the API — order pricing, the checkout quote, meal plans,
// subscription billing, the stored invoice, refunds — resolves through the row
// edited here, so a change lands everywhere at once with no deploy.
//
// The calculator below is not a model of the pricing. It posts to
// /admin/pricing/simulate, which runs the SAME functions that charge and refund
// real money, so what it shows is what the platform will actually do.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { useConfirm } from "@/components/admin/confirm-dialog";

type TaxRate = {
  id: string;
  countryCode: string;
  region: string;
  taxName: string;
  rate: number;
  inclusive: boolean;
  foodPercent: number;
  servicePercent: number;
  serviceInclusive: boolean;
  deliverySelfPercent: number;
  deliveryPlatformPercent: number;
  subscriptionPercent: number;
  registrationIdLabel?: string;
  companyTaxId?: string;
  notes?: string;
  isActive: boolean;
};

type TaxLine = { code: string; label: string; rate: number; amount: number };

type Pricing = {
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  discount: number;
  tip: number;
  tax: number;
  taxFood: number;
  taxService: number;
  taxDelivery: number;
  taxLines: TaxLine[];
  taxBreakdown: TaxLine[];
  rounding?: number;
  total: number;
};

type ValidationCheck = { name: string; passed: boolean; detail: string };

type Refund = {
  label: string;
  foodRefundPct: number;
  dispatched: boolean;
  customerGets: number;
  foodRefund: number;
  deliveryRefund: number;
  taxRefund: number;
  chefKeeps: number;
  platformKeeps: number;
  creditNote: number;
  platformMargin: number;
  taxRefundFood: number;
  taxRefundDelivery: number;
  taxKeptOnFee: number;
  conserves: boolean;
  warnings?: string[];
};

type Scenario = {
  fulfillment: string;
  label: string;
  pricing: Pricing;
  rates: {
    food: number;
    service: number;
    serviceInclusive: boolean;
    delivery: number;
    deliveryByPlatform: boolean;
  };
  gateway: { percent: number; fee: number; taxOnFee: number; gross: number; real: number };
  refunds: Refund[];
  validations: ValidationCheck[];
};

type Simulation = {
  input: Record<string, unknown>;
  thirdPartyDeliveryLive: boolean;
  scenarios: Scenario[];
};

// Money is two decimals everywhere, including here — the API guarantees it and
// this must not be the surface that reintroduces a third.
const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct = (n: number) => `${Number(n.toFixed(2))}%`;

function Field({
  label,
  hint,
  value,
  onChange,
  step = "0.01",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  step?: string;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block font-medium text-foreground">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full w-full rounded-md border px-3 py-2 text-sm tabular-nums"
      />
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4"
      />
      <span>
        <span className="block font-medium text-foreground">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

export default function TaxRatesPage() {
  const { confirm } = useConfirm();
  // The key MUST be a tuple — swrFetcher destructures it as [path, search], so a
  // bare string is destructured character-wise into path "/" and search "t",
  // which requested /gw?0=t and 404'd.
  const { data, error, isLoading, mutate } = useSWR<{ data: TaxRate[] }>(
    ["/tax-rates"],
    swrFetcher,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaxRate | null>(null);

  const rows = data?.data ?? [];
  const editing = draft ?? rows.find((r) => r.countryCode === "IN" && !r.region) ?? rows[0] ?? null;

  function patch(next: Partial<TaxRate>) {
    if (!editing) return;
    setDraft({ ...editing, ...next });
  }

  async function save() {
    if (!editing) return;
    const ok = await confirm({
      title: "Re-price every new order?",
      message:
        "These rates take effect on the next order placed — nothing already charged changes. Orders in flight keep the rates frozen on them.",
      confirmLabel: "Save rates",
    });
    if (!ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      await hcAdmin.post("/tax-rates", {
        countryCode: editing.countryCode,
        region: editing.region,
        taxName: editing.taxName,
        rate: editing.rate,
        inclusive: editing.inclusive,
        foodPercent: editing.foodPercent,
        servicePercent: editing.servicePercent,
        serviceInclusive: editing.serviceInclusive,
        deliverySelfPercent: editing.deliverySelfPercent,
        deliveryPlatformPercent: editing.deliveryPlatformPercent,
        subscriptionPercent: editing.subscriptionPercent,
        registrationIdLabel: editing.registrationIdLabel ?? "",
        companyTaxId: editing.companyTaxId ?? "",
        notes: editing.notes ?? "",
        isActive: editing.isActive,
      });
      setDraft(null);
      await mutate();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Tax rates</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The single source of truth for tax across the platform. Order pricing, the
          checkout quote, meal plans, subscription billing, invoices and refunds all
          read these rates — a change here lands everywhere at once, with no deploy.
          Rates already frozen on placed orders are never restated.
        </p>
      </header>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {error ? (
        <p className="text-sm text-red-600">
          Could not load tax rates: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}

      {editing ? (
        <>
          <section className="space-y-4 rounded-lg border p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">
                {editing.countryCode}
                {editing.region ? ` · ${editing.region}` : ""} — {editing.taxName}
              </h2>
              <select
                value={editing.id}
                onChange={(e) => setDraft(rows.find((r) => r.id === e.target.value) ?? null)}
                className="rounded-md border px-3 py-1.5 text-sm"
              >
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.countryCode}
                    {r.region ? ` · ${r.region}` : ""} — {r.taxName}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field
                label="Default rate"
                hint="Applied to any supply left at 0 below."
                value={String(editing.rate)}
                onChange={(v) => patch({ rate: Number(v) })}
              />
              <Field
                label="Food"
                hint="Restaurant service. In India 5%, and it carries no input credit."
                value={String(editing.foodPercent)}
                onChange={(v) => patch({ foodPercent: Number(v) })}
              />
              <Field
                label="Platform fee"
                hint="The platform's own service to the customer — not restaurant service."
                value={String(editing.servicePercent)}
                onChange={(v) => patch({ servicePercent: Number(v) })}
              />
              <Field
                label="Delivery — chef carries it"
                hint="Door delivery by the cook, arguable as part of the composite restaurant supply."
                value={String(editing.deliverySelfPercent)}
                onChange={(v) => patch({ deliverySelfPercent: Number(v) })}
              />
              <Field
                label="Delivery — platform rider"
                hint="Local delivery through an e-commerce operator: a notified §9(5) supply since 22 Sep 2025."
                value={String(editing.deliveryPlatformPercent)}
                onChange={(v) => patch({ deliveryPlatformPercent: Number(v) })}
              />
              <Field
                label="Subscription"
                hint="Recurring plan fee — a standard-rated service."
                value={String(editing.subscriptionPercent)}
                onChange={(v) => patch({ subscriptionPercent: Number(v) })}
              />
            </div>

            <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
              <Toggle
                label="Platform fee is quoted all-in"
                hint="On: the customer's fee does not move and the tax is taken out of it — your margin absorbs it. Off: the tax is added on top and the customer pays more."
                checked={editing.serviceInclusive}
                onChange={(v) => patch({ serviceInclusive: v })}
              />
              <Toggle
                label="Food price already includes tax"
                hint="European VAT style. Off for India, where GST is added to the menu price."
                checked={editing.inclusive}
                onChange={(v) => patch({ inclusive: v })}
              />
            </div>

            <div className="flex items-center gap-3 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !draft}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save rates"}
              </button>
              {draft ? (
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="text-sm text-muted-foreground underline"
                >
                  Discard changes
                </button>
              ) : null}
              {saveError ? <span className="text-sm text-red-600">{saveError}</span> : null}
            </div>
          </section>

        </>
      ) : null}

      {/* Outside the editor block on purpose: the calculator simulates against
          the rates the API already holds, so it must still work when the editor
          could not load — which is exactly when an operator most wants it. */}
      <Calculator />
    </div>
  );
}

// ─────────────────────────── Calculator ───────────────────────────

function Calculator() {
  const [subtotal, setSubtotal] = useState("500");
  const [deliveryFee, setDeliveryFee] = useState("39");
  const [discount, setDiscount] = useState("0");
  const [tip, setTip] = useState("0");
  const [gateway, setGateway] = useState("1.95");
  const [sim, setSim] = useState<Simulation | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    try {
      setSim(
        await hcAdmin.post<Simulation>("/pricing/simulate", {
          subtotal: Number(subtotal),
          deliveryFee: Number(deliveryFee),
          discount: Number(discount),
          tip: Number(tip),
          gatewayFeePercent: Number(gateway),
        }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border p-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">Calculator</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Runs an order through the rates saved above, in every fulfilment mode and
          every refund tier. It calls the same pricing and refund functions that
          charge real money, so nothing here is a separate model that can drift.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Field label="Food subtotal" value={subtotal} onChange={setSubtotal} />
        <Field label="Delivery fee" value={deliveryFee} onChange={setDeliveryFee} />
        <Field label="Promo discount" value={discount} onChange={setDiscount} />
        <Field label="Tip" value={tip} onChange={setTip} />
        <Field
          label="Gateway MDR %"
          hint="Not returned on a refund."
          value={gateway}
          onChange={setGateway}
        />
      </div>

      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {running ? "Calculating…" : "Calculate"}
      </button>
      {err ? <p className="text-sm text-red-600">{err}</p> : null}

      {sim ? (
        <div className="space-y-6">
          {!sim.thirdPartyDeliveryLive ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
              No third-party delivery provider is enabled, so every real delivery order
              is currently carried by the chef and takes the chef-delivery rate. The
              platform-rider row below is shown for comparison only.
            </p>
          ) : null}
          {/* The three modes side by side, so the difference between them is read
              across a row rather than reconstructed from three separate cards. */}
          <div className="grid gap-4 lg:grid-cols-3">
            {sim.scenarios.map((s) => (
              <BreakdownColumn key={s.fulfillment} scenario={s} />
            ))}
          </div>

          {sim.scenarios.map((s) => (
            <RefundBlock key={`r-${s.fulfillment}`} scenario={s} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// One fulfilment mode as a single column: the invoice-grade lines, the footing
// check, what the customer actually sees, and what Cashfree takes.
function BreakdownColumn({ scenario: s }: { scenario: Scenario }) {
  const p = s.pricing;
  const rows =
    Math.round(
      (p.subtotal + p.deliveryFee + p.platformFee - p.discount + p.tip + p.tax + (p.rounding ?? 0)) *
        100,
    ) / 100;
  const foots = rows === p.total;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{s.label}</h3>
        <p className="text-[11px] text-muted-foreground">
          food {pct(s.rates.food)} · fee {pct(s.rates.service)}
          {s.rates.serviceInclusive ? " all-in" : ""}
          {p.deliveryFee > 0 ? ` · delivery ${pct(s.rates.delivery)}` : ""}
        </p>
      </div>

      <table className="w-full text-sm">
        <tbody>
          <Row label="Food" value={p.subtotal} />
          {p.deliveryFee > 0 ? <Row label="Delivery" value={p.deliveryFee} /> : null}
          {p.platformFee > 0 ? <Row label="Platform fee" value={p.platformFee} /> : null}
          {p.taxBreakdown.map((l, i) => (
            <Row key={`${l.code}-${i}`} label={l.label} value={l.amount} />
          ))}
          {p.discount > 0 ? <Row label="Discount" value={-p.discount} /> : null}
          {p.tip > 0 ? <Row label="Tip" value={p.tip} /> : null}
          {p.rounding ? <Row label="Rounding" value={p.rounding} /> : null}
          <Row label="TOTAL" value={p.total} bold />
        </tbody>
      </table>

      <p className={`text-xs ${foots ? "text-emerald-600" : "text-red-600"}`}>
        {foots ? `foots ✓  (rows = ${inr(rows)})` : `DOES NOT FOOT ✗  rows ${inr(rows)}`}
      </p>

      <div className="rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
        <p className="font-medium text-foreground">What the customer sees</p>
        {p.taxLines.map((l, i) => (
          <p key={`s-${l.code}-${i}`} className="flex justify-between tabular-nums">
            <span>{l.label}</span>
            <span>{inr(l.amount)}</span>
          </p>
        ))}
      </div>

      <div className="rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
        <p className="font-medium text-foreground">Cashfree ({pct(s.gateway.percent)} MDR)</p>
        <p className="flex justify-between tabular-nums">
          <span>MDR</span>
          <span>{inr(s.gateway.fee)}</span>
        </p>
        <p className="flex justify-between tabular-nums">
          <span>GST on MDR</span>
          <span>{inr(s.gateway.taxOnFee)}</span>
        </p>
        <p className="flex justify-between tabular-nums font-medium text-foreground">
          <span>Real cost (after ITC)</span>
          <span>{inr(s.gateway.real)}</span>
        </p>
        <p className="mt-1">Sunk at capture — never returned on a refund.</p>
      </div>

      <Validations checks={s.validations} />
    </div>
  );
}

// The refund tiers for one mode. Full width because the columns are wide.
function RefundBlock({ scenario: s }: { scenario: Scenario }) {
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <h3 className="text-sm font-semibold text-foreground">If refunded — {s.label}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Scenario</th>
              <th className="py-1 text-right font-medium">Customer gets</th>
              <th className="py-1 text-right font-medium">Chef keeps</th>
              <th className="py-1 text-right font-medium">Credit note</th>
              <th className="py-1 text-right font-medium">You keep</th>
              <th className="py-1 text-right font-medium">Your margin</th>
            </tr>
          </thead>
          <tbody>
            {s.refunds.map((r, i) => (
              <tr key={i} className="border-t align-top">
                <td className="py-1.5 pr-2">
                  {r.label}
                  {r.creditNote > 0 ? (
                    <span className="block text-[11px] text-muted-foreground">
                      credit note: food {inr(r.taxRefundFood)}
                      {r.taxRefundDelivery > 0 ? ` + delivery ${inr(r.taxRefundDelivery)}` : ""} ·
                      fee tax {inr(r.taxKeptOnFee)} kept
                    </span>
                  ) : null}
                  {(r.warnings ?? []).map((w) => (
                    <span key={w} className="block text-[11px] text-amber-700">
                      {w}
                    </span>
                  ))}
                </td>
                <td className="py-1.5 text-right tabular-nums">{inr(r.customerGets)}</td>
                <td className="py-1.5 text-right tabular-nums">{inr(r.chefKeeps)}</td>
                <td className="py-1.5 text-right tabular-nums">{inr(r.creditNote)}</td>
                <td className="py-1.5 text-right tabular-nums">{inr(r.platformKeeps)}</td>
                <td
                  className={`py-1.5 text-right tabular-nums ${
                    r.platformMargin < 0 ? "text-red-600" : ""
                  }`}
                >
                  {inr(r.platformMargin)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        &ldquo;Your margin&rdquo; is what is left after the gateway fee, which is sunk at
        capture. Negative means the cancellation costs money — recoverable from the chef
        when the gateway-fee levy is on.
      </p>
    </div>
  );
}

// The invariants, checked on the numbers above rather than assumed. A rate change
// that breaks one shows here immediately instead of at the next reconciliation.
function Validations({ checks }: { checks: ValidationCheck[] }) {
  const failed = checks.filter((c) => !c.passed);
  return (
    <div
      className={`rounded-md border px-3 py-2 text-xs ${
        failed.length ? "border-red-300 bg-red-50" : "border-border bg-background"
      }`}
    >
      <p className="mb-1 font-semibold text-foreground">
        {failed.length ? `${failed.length} check failed` : `All ${checks.length} checks passed`}
      </p>
      <ul className="space-y-0.5">
        {checks.map((c) => (
          <li key={c.name} className={c.passed ? "text-muted-foreground" : "text-red-700"}>
            {c.passed ? "✓" : "✗"} {c.name}
            {c.passed ? null : <span className="ml-1 opacity-80">— {c.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <tr className={bold ? "border-t border-border font-semibold" : ""}>
      <td className="py-1">{label}</td>
      <td className="py-1 text-right tabular-nums">{inr(value)}</td>
    </tr>
  );
}
