"use client";

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, formatINR, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type { OrderIssue, OrderIssueConfig, Paginated, SupportTicket } from "@/lib/products/homechef/contracts";

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];

// #618 fault policy for resolving an order-issue refund (see AdminResolveIssue).
type FaultPolicy = "chef_clawback" | "platform_goodwill";

function ticketTone(s: string): Tone {
  if (s === "resolved" || s === "closed") return "success";
  if (s === "open") return "warning";
  return "info";
}
function priorityTone(p: string): Tone {
  if (p === "urgent" || p === "high") return "danger";
  if (p === "low") return "neutral";
  return "info";
}
function issueTone(s: string): Tone {
  if (s === "resolved") return "success";
  if (s === "rejected") return "danger";
  return "warning";
}

function TicketsTab() {
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading, mutate } = useSWR<Paginated<SupportTicket>>(
    ["/support/tickets", { status, page: 1, limit: 50 }],
    swrFetcher,
    { refreshInterval: 30_000 },
  );

  async function setTicketStatus(id: string, next: string) {
    setError(null);
    setBusyId(id);
    try {
      await hcAdmin.put(`/support/tickets/${id}/status`, { status: next });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  const tickets = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {[{ key: "", label: "All" }, ...TICKET_STATUSES.map((s) => ({ key: s, label: titleCase(s) }))].map(
          (f) => (
            <button
              key={f.key}
              onClick={() => setStatus(f.key)}
              className={`rounded-md px-3 py-1.5 text-sm ${
                status === f.key
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {f.label}
            </button>
          ),
        )}
      </div>
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Ticket</th>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Set status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
            ) : tickets.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No tickets.</td></tr>
            ) : (
              tickets.map((t) => (
                <tr key={t.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono text-xs">{t.ticketNumber || t.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 max-w-xs truncate">{t.subject}</td>
                  <td className="px-4 py-3 text-muted-foreground">{titleCase(t.category)}</td>
                  <td className="px-4 py-3"><StatusBadge label={titleCase(t.priority)} tone={priorityTone(t.priority)} /></td>
                  <td className="px-4 py-3"><StatusBadge label={titleCase(t.status)} tone={ticketTone(t.status)} /></td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDateTime(t.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <select
                      value={t.status}
                      disabled={busyId === t.id}
                      onChange={(e) => setTicketStatus(t.id, e.target.value)}
                      className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                    >
                      {TICKET_STATUSES.map((s) => (
                        <option key={s} value={s}>{titleCase(s)}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Admin-tunable refund policy (#262): order-issue refunds at or below the cap are
// paid to the customer's wallet automatically; above it they queue here for review.
function IssuePolicyCard() {
  const { data, mutate } = useSWR<OrderIssueConfig>(["/order-issue/config", {}], swrFetcher);
  const { prompt } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!data) return null;

  async function update(payload: { enabled?: boolean; autoApproveCap?: number }) {
    setError(null);
    setBusy(true);
    try {
      await hcAdmin.put("/order-issue/config", payload);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the policy");
    } finally {
      setBusy(false);
    }
  }

  async function editCap() {
    const v = await prompt({
      title: "Auto-approve cap",
      message:
        "Order-issue refunds at or below this amount (₹) are paid to the customer's wallet automatically; anything above waits here for review.",
      label: "Cap (₹)",
      defaultValue: String(data?.autoApproveCap ?? ""),
      numeric: true,
      required: true,
      confirmLabel: "Save cap",
    });
    if (v === null) return;
    await update({ autoApproveCap: Number(v) });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">Auto-approve policy</p>
        <p className="text-xs text-muted-foreground">
          {data.enabled ? "Enabled" : "Disabled"} · refunds up to{" "}
          <span className="font-medium tabular-nums text-foreground">{formatINR(data.autoApproveCap)}</span> are
          paid automatically.
        </p>
        {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => update({ enabled: !data.enabled })}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          {data.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={editCap}
          className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
        >
          Edit cap
        </button>
      </div>
    </div>
  );
}

function IssuesTab() {
  const [status, setStatus] = useState("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, prompt } = useConfirm();
  const { data, isLoading, mutate } = useSWR<{ data: OrderIssue[]; count: number }>(
    ["/order-issues", { status }],
    swrFetcher,
    { refreshInterval: 30_000 },
  );

  // #618: resolving a refund carries a FAULT POLICY. `chef_clawback` (the default)
  // reverses the chef's payout; `platform_goodwill` refunds the customer but lets the
  // chef KEEP their payout (platform absorbs the cost) — PARTIAL refunds only, so the
  // backend 422s a goodwill request that would fully refund (surfaced via e.message).
  async function resolve(it: OrderIssue, policy: FaultPolicy) {
    const goodwill = policy === "platform_goodwill";
    const amtStr = await prompt({
      title: goodwill ? "Goodwill refund" : "Resolve & refund",
      message: goodwill
        ? `Refund the customer as platform goodwill — the chef KEEPS their payout and the platform absorbs the cost. Partial refunds only. Requested: ${formatINR(it.requestedAmount)}.`
        : `Approve a refund and claw it back from the chef's payout. Requested: ${formatINR(it.requestedAmount)}.`,
      label: "Refund amount (₹)",
      // Goodwill is PARTIAL-only (a full refund 422s), so don't pre-fill the full
      // requested amount — start blank so the happy path isn't a guaranteed reject.
      placeholder: goodwill ? "Partial amount (less than full)" : String(it.requestedAmount || ""),
      defaultValue: goodwill ? "" : String(it.requestedAmount || ""),
      numeric: true,
      required: true,
      confirmLabel: goodwill ? "Refund as goodwill" : "Resolve & refund",
    });
    if (amtStr === null) return;
    const amount = Number(amtStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid amount greater than zero.");
      return;
    }
    setError(null);
    setBusyId(it.id);
    try {
      await hcAdmin.post(`/order-issues/${it.id}/resolve`, { amount, faultPolicy: policy });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolve failed");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(it: OrderIssue) {
    const ok = await confirm({
      title: "Reject refund request",
      message: "Reject this refund request? The customer will not be refunded.",
      confirmLabel: "Reject",
      tone: "destructive",
    });
    if (!ok) return;
    setError(null);
    setBusyId(it.id);
    try {
      await hcAdmin.post(`/order-issues/${it.id}/reject`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  const issues = data?.data ?? [];

  return (
    <div className="space-y-4">
      <IssuePolicyCard />
      <div className="flex gap-1">
        {["pending", "resolved", "rejected"].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-md px-3 py-1.5 text-sm capitalize ${
              status === s ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/70"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3 text-right">Requested</th>
              <th className="px-4 py-3 text-right">Refunded</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
            ) : issues.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No issues.</td></tr>
            ) : (
              issues.map((it) => (
                <tr key={it.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono text-xs">{it.orderId.slice(0, 8)}</td>
                  <td className="px-4 py-3">
                    <div>{titleCase(it.reason)}</div>
                    {it.description ? (
                      <div className="text-xs text-muted-foreground max-w-xs truncate">{it.description}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatINR(it.requestedAmount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatINR(it.refundAmount)}</td>
                  <td className="px-4 py-3"><StatusBadge label={titleCase(it.status)} tone={issueTone(it.status)} /></td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDateTime(it.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {it.status === "pending" ? (
                      <div className="flex justify-end gap-2">
                        <button
                          disabled={busyId === it.id}
                          onClick={() => resolve(it, "chef_clawback")}
                          className="rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background disabled:opacity-50"
                          title="Refund the customer and claw it back from the chef's payout"
                        >
                          Resolve
                        </button>
                        <button
                          disabled={busyId === it.id}
                          onClick={() => resolve(it, "platform_goodwill")}
                          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                          title="Refund the customer as goodwill — the chef keeps their payout (partial refunds only)"
                        >
                          Goodwill
                        </button>
                        <button
                          disabled={busyId === it.id}
                          onClick={() => reject(it)}
                          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function HomechefSupportPage() {
  const [tab, setTab] = useState<"tickets" | "issues">("tickets");
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Support</h1>
        <p className="text-sm text-muted-foreground">Customer support tickets & refund (order) issues</p>
      </div>
      <div className="flex gap-2 border-b border-border">
        {(["tickets", "issues"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "tickets" ? "Tickets" : "Order issues"}
          </button>
        ))}
      </div>
      {tab === "tickets" ? <TicketsTab /> : <IssuesTab />}
    </div>
  );
}
