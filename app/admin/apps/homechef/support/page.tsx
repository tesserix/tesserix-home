"use client";

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, formatINR, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type { OrderIssue, Paginated, SupportTicket } from "@/lib/products/homechef/contracts";

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];

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

  async function resolve(it: OrderIssue) {
    const amtStr = await prompt({
      title: "Resolve & refund",
      message: `Approve a refund for this order issue. Requested: ${formatINR(it.requestedAmount)}.`,
      label: "Refund amount (₹)",
      placeholder: String(it.requestedAmount || ""),
      defaultValue: String(it.requestedAmount || ""),
      numeric: true,
      required: true,
      confirmLabel: "Resolve & refund",
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
      await hcAdmin.post(`/order-issues/${it.id}/resolve`, { amount });
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
                          onClick={() => resolve(it)}
                          className="rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background disabled:opacity-50"
                        >
                          Resolve
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

interface DeliveryFailureRow {
  issueId: string;
  orderId: string;
  orderNumber: string;
  chefId: string;
  total: number;
  holdStatus: string;
  reason: string;
  suggestedFault: string;
  reportedBy: string;
  createdAt: string;
}

type FaultClass = "customer" | "platform" | "chef";

// The money outcome of each fault class (#393 RTO policy), shown before the admin
// confirms — the outcomes are opposite and irreversible.
const FAULT_OUTCOME: Record<FaultClass, string> = {
  customer: "Chef is PAID in full. Customer is NOT refunded, delivery fee retained.",
  platform: "Customer is refunded in full and the chef's payout hold is reversed.",
  chef: "Customer is refunded in full and the chef's payout hold is reversed.",
};

function faultTone(f: string): Tone {
  if (f === "customer") return "info";
  if (f === "ambiguous") return "neutral";
  return "warning";
}

// Delivery-failure resolution queue (#393): a chef/courier reported a failed
// delivery; the admin confirms fault and the fault-based money policy executes.
// Kept separate from the generic refund flow (those are excluded server-side).
function DeliveryFailuresTab() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();
  const { data, isLoading, mutate } = useSWR<{ orderIssues: DeliveryFailureRow[]; count: number }>(
    ["/delivery-failures", {}],
    swrFetcher,
    { refreshInterval: 30_000 },
  );

  async function resolveFault(it: DeliveryFailureRow, fault: FaultClass) {
    const ok = await confirm({
      title: `Confirm ${fault} fault`,
      message: `${FAULT_OUTCOME[fault]} This cannot be undone.`,
      confirmLabel: `Confirm ${fault} fault`,
      tone: fault === "customer" ? "default" : "destructive",
    });
    if (!ok) return;
    setError(null);
    setBusyId(it.issueId);
    try {
      await hcAdmin.post(`/order-issues/${it.issueId}/resolve-delivery-failure`, { fault });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolve failed");
    } finally {
      setBusyId(null);
    }
  }

  const rows = data?.orderIssues ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A chef or courier reported a failed delivery. Confirm who was at fault — the money
        outcome follows the RTO policy and cannot be undone. The chef&apos;s payout is held
        until you resolve it.
      </p>
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Reported by</th>
              <th className="px-4 py-3">Suggested</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Confirm fault</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No delivery failures to resolve.</td></tr>
            ) : (
              rows.map((it) => (
                <tr key={it.issueId} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono text-xs">{it.orderNumber || it.orderId.slice(0, 8)}</td>
                  <td className="px-4 py-3">{titleCase(it.reason.replace(/_/g, " "))}</td>
                  <td className="px-4 py-3 text-muted-foreground">{titleCase(it.reportedBy.replace(/_/g, " "))}</td>
                  <td className="px-4 py-3"><StatusBadge label={titleCase(it.suggestedFault)} tone={faultTone(it.suggestedFault)} /></td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatINR(it.total)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDateTime(it.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {(["customer", "platform", "chef"] as const).map((f) => (
                        <button
                          key={f}
                          disabled={busyId === it.issueId}
                          onClick={() => resolveFault(it, f)}
                          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70 disabled:opacity-50"
                        >
                          {titleCase(f)}
                        </button>
                      ))}
                    </div>
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
  const [tab, setTab] = useState<"tickets" | "issues" | "delivery">("tickets");
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Support</h1>
        <p className="text-sm text-muted-foreground">Support tickets, refund (order) issues & delivery failures</p>
      </div>
      <div className="flex gap-2 border-b border-border">
        {(["tickets", "issues", "delivery"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "tickets" ? "Tickets" : t === "issues" ? "Order issues" : "Delivery failures"}
          </button>
        ))}
      </div>
      {tab === "tickets" ? <TicketsTab /> : tab === "issues" ? <IssuesTab /> : <DeliveryFailuresTab />}
    </div>
  );
}
