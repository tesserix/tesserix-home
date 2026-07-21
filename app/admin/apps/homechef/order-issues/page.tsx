"use client";

// HomeChef ORDER ISSUES (#43). A customer reports a problem with a delivered
// order; small/clear cases auto-refund up to the cap, the rest queue here for an
// admin to resolve at an amount or reject. Migrated from the HomeChef
// admin-portal into the unified Tesserix admin.
//
// The money seams stay server-side and are deliberately NOT re-implemented here:
// the Go API caps the refund at the order's remaining refundable amount under an
// order lock, rejects an already-handled issue, and runs the payout cross-guard.
// This screen proposes an amount; the API decides what actually moves.

import { useEffect, useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatINR, formatDateTime, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type {
  IssueFaultPolicy,
  OrderIssue,
  OrderIssueConfig,
  OrderIssueStatus,
} from "@/lib/products/homechef/contracts";

const FAULT_POLICIES: ReadonlyArray<{ value: IssueFaultPolicy; label: string }> = [
  { value: "chef_clawback", label: "Chef clawback" },
  { value: "platform_goodwill", label: "Platform goodwill" },
];

const TABS: ReadonlyArray<{ value: OrderIssueStatus | "all"; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "auto_refunded", label: "Auto-refunded" },
  { value: "resolved", label: "Resolved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

function statusTone(s: string): Tone {
  if (s === "pending") return "warning";
  if (s === "rejected") return "danger";
  return "success";
}

function ConfigCard() {
  const { data, isLoading, mutate } = useSWR<OrderIssueConfig>(["/order-issue/config"], swrFetcher);
  const [form, setForm] = useState<OrderIssueConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      await hcAdmin.put<OrderIssueConfig>("/order-issue/config", form);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the policy.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !form) return null;

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border p-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        Reporting enabled
      </label>
      <label className="space-y-1 text-sm">
        <span className="block font-medium">Auto-approve under (₹)</span>
        <input
          type="number"
          min={0}
          className="w-40 rounded-md border px-3 py-2"
          value={String(form.autoApproveCap ?? "")}
          onChange={(e) => setForm({ ...form, autoApproveCap: Number(e.target.value) })}
        />
        <span className="block text-xs text-muted-foreground">
          Claims below this refund instantly, with no admin review.
        </span>
      </label>
      <label className="space-y-1 text-sm">
        <span className="block font-medium">Default fault policy</span>
        <select
          className="w-48 rounded-md border px-3 py-2"
          value={form.defaultFaultPolicy ?? "chef_clawback"}
          onChange={(e) =>
            setForm({ ...form, defaultFaultPolicy: e.target.value as IssueFaultPolicy })
          }
        >
          {FAULT_POLICIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="block text-xs text-muted-foreground">
          Who bears a resolved refund by default — clawed back from the chef or absorbed
          by the platform.
        </span>
      </label>
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save policy"}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export default function HomechefOrderIssuesPage() {
  const [tab, setTab] = useState<OrderIssueStatus | "all">("pending");
  // Per-row resolve amount, seeded from what the customer asked for.
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // Per-row fault policy, seeded from the config default when unset.
  const [policies, setPolicies] = useState<Record<string, IssueFaultPolicy>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  // Shares SWR cache with the ConfigCard fetch; used to seed each row's policy.
  const { data: config } = useSWR<OrderIssueConfig>(["/order-issue/config"], swrFetcher);
  const defaultPolicy: IssueFaultPolicy =
    (config?.defaultFaultPolicy as IssueFaultPolicy) ?? "chef_clawback";

  const { data, isLoading, mutate } = useSWR<{ data: OrderIssue[] }>(
    ["/order-issues", tab === "all" ? {} : { status: tab }],
    swrFetcher,
    { refreshInterval: 30_000 },
  );

  const issues = data?.data ?? [];

  async function resolve(issue: OrderIssue) {
    const raw = amounts[issue.id] ?? String(issue.requestedAmount);
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a positive refund amount.");
      return;
    }
    const faultPolicy = policies[issue.id] ?? defaultPolicy;
    // Name the amount and that it is final — the API will not let it be clawed
    // back from here.
    const ok = await confirm({
      title: "Refund this issue?",
      message: `${formatINR(amount)} will be refunded to the customer for order ${issue.orderId.slice(0, 8)}. This cannot be undone from this screen.`,
      confirmLabel: "Refund",
    });
    if (!ok) return;

    setBusyId(issue.id);
    setError(null);
    try {
      await hcAdmin.post(`/order-issues/${issue.id}/resolve`, { amount, faultPolicy });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resolve the issue.");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(issue: OrderIssue) {
    const ok = await confirm({
      title: "Reject this claim?",
      message: "The customer is told their claim was rejected and no refund is issued.",
      confirmLabel: "Reject",
      tone: "destructive",
    });
    if (!ok) return;

    setBusyId(issue.id);
    setError(null);
    try {
      await hcAdmin.post(`/order-issues/${issue.id}/reject`, {});
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reject the claim.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Order issues</h1>
        <p className="text-sm text-muted-foreground">
          Customer-reported problems on delivered orders. The API caps every refund at what is still
          refundable on the order, so an amount entered here may be reduced.
        </p>
      </div>

      <ConfigCard />

      <div className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === t.value ? "bg-primary text-primary-foreground" : "border"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : issues.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="p-3">Reported</th>
                <th className="p-3">Order</th>
                <th className="p-3">Reason</th>
                <th className="p-3 text-right">Requested</th>
                <th className="p-3 text-right">Refunded</th>
                <th className="p-3">Status</th>
                <th className="p-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.id} className="border-b last:border-0 align-top">
                  <td className="p-3 whitespace-nowrap">{formatDateTime(i.createdAt)}</td>
                  <td className="p-3 font-mono text-xs">{i.orderId.slice(0, 8)}</td>
                  <td className="p-3">
                    <div>{titleCase(i.reason)}</div>
                    {i.description ? (
                      <div className="text-xs text-muted-foreground">{i.description}</div>
                    ) : null}
                    {i.photoUrls && i.photoUrls.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {i.photoUrls.map((url, idx) => (
                          <a
                            key={idx}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="block h-14 w-14 overflow-hidden rounded-md border"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={url}
                              alt={`Evidence ${idx + 1}`}
                              className="h-full w-full object-cover"
                            />
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-3 text-right tabular-nums">{formatINR(i.requestedAmount)}</td>
                  <td className="p-3 text-right tabular-nums">
                    {i.refundAmount > 0 ? formatINR(i.refundAmount) : "—"}
                  </td>
                  <td className="p-3">
                    <StatusBadge tone={statusTone(i.status)} label={titleCase(i.status)} />
                  </td>
                  <td className="p-3">
                    {i.status === "pending" ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          className="w-24 rounded-md border px-2 py-1"
                          value={amounts[i.id] ?? String(i.requestedAmount)}
                          onChange={(e) => setAmounts({ ...amounts, [i.id]: e.target.value })}
                          aria-label="Refund amount"
                        />
                        <select
                          className="rounded-md border px-2 py-1 text-xs"
                          value={policies[i.id] ?? defaultPolicy}
                          onChange={(e) =>
                            setPolicies({
                              ...policies,
                              [i.id]: e.target.value as IssueFaultPolicy,
                            })
                          }
                          aria-label="Fault policy"
                        >
                          {FAULT_POLICIES.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => void resolve(i)}
                          disabled={busyId === i.id}
                          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-60"
                        >
                          Refund
                        </button>
                        <button
                          type="button"
                          onClick={() => void reject(i)}
                          disabled={busyId === i.id}
                          className="rounded-md border px-3 py-1 text-xs disabled:opacity-60"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {i.resolvedAt ? formatDateTime(i.resolvedAt) : "—"}
                      </span>
                    )}
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
