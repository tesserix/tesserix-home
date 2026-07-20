"use client";

import { Fragment, useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, formatINR, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type { OrderIssue, OrderIssueConfig, Paginated, SupportTicket } from "@/lib/products/homechef/contracts";

const TICKET_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_customer",
  "waiting_on_chef",
  "resolved",
  "closed",
];
const TICKET_CATEGORIES = [
  "order_issue",
  "payment_issue",
  "account_issue",
  "chef_complaint",
  "delivery_complaint",
  "technical",
  "other",
];
const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"];

// AdminGetTicket (GET /support/tickets/:id) returns SupportTicketResponse — the
// list SupportTicket plus the reporter name and the full conversation.
interface SupportMessageDTO {
  id: string;
  senderId: string;
  senderRole: string;
  senderName?: string;
  content: string;
  isInternal: boolean;
  createdAt: string;
}
interface SupportTicketDetail extends SupportTicket {
  reporterName?: string;
  messages?: SupportMessageDTO[];
}
// A trimmed staff row for the assignee picker (GET /admin/staff → StaffMemberResponse).
interface StaffLite {
  userId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}
interface SupportStats {
  total: number;
  open: number;
  resolved: number;
  byStatus: Record<string, number>;
  avgResolutionHours: number;
}

function staffLabel(s: StaffLite): string {
  const name = `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim();
  return name || s.email || s.userId.slice(0, 8);
}

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

// A compact SLA/summary strip from AdminGetSupportStats (GET /support/stats).
function StatsRow() {
  const { data } = useSWR<SupportStats>(["/support/stats", {}], swrFetcher, {
    refreshInterval: 60_000,
  });
  if (!data) return null;
  const cells = [
    { label: "Total", value: String(data.total) },
    { label: "Open", value: String(data.open) },
    { label: "Resolved", value: String(data.resolved) },
    { label: "Avg. resolution", value: `${data.avgResolutionHours.toFixed(1)}h` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">{c.label}</p>
          <p className="text-lg font-semibold tabular-nums text-foreground">{c.value}</p>
        </div>
      ))}
    </div>
  );
}

// Expanded ticket detail: the full conversation plus admin actions (assign,
// reply, internal note). Only fetches once the row is opened.
function TicketDetail({
  ticketId,
  staff,
  onChanged,
}: {
  ticketId: string;
  staff: StaffLite[];
  onChanged: () => void;
}) {
  const { data, isLoading, mutate } = useSWR<SupportTicketDetail>(
    [`/support/tickets/${ticketId}`],
    swrFetcher,
  );
  const [content, setContent] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!content.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await hcAdmin.post(`/support/tickets/${ticketId}/messages`, {
        content: content.trim(),
        isInternal,
      });
      setContent("");
      await mutate();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the message.");
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    if (!assignee) return;
    setError(null);
    setBusy(true);
    try {
      await hcAdmin.put(`/support/tickets/${ticketId}/assign`, { assignedToId: assignee });
      await mutate();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not assign the ticket.");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading || !data) {
    return <p className="px-4 py-4 text-sm text-muted-foreground">Loading conversation…</p>;
  }

  const assignedName = data.assignedToId
    ? staffLabel(
        staff.find((s) => s.userId === data.assignedToId) ?? {
          userId: data.assignedToId,
        },
      )
    : null;

  return (
    <div className="space-y-4 bg-muted/20 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Reporter: <span className="text-foreground">{data.reporterName || "—"}</span>{" "}
          <span className="text-xs">({titleCase(data.reporterRole)})</span>
        </p>
        <div className="flex items-center gap-2">
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          >
            <option value="">
              {assignedName ? `Assigned: ${assignedName}` : "Assign to…"}
            </option>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {staffLabel(s)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !assignee}
            onClick={() => void assign()}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Assign
          </button>
        </div>
      </div>

      {data.description ? (
        <div className="rounded-md border border-border bg-background p-3 text-sm">
          <p className="mb-1 text-xs text-muted-foreground">Original request</p>
          {data.description}
        </div>
      ) : null}

      <div className="space-y-2">
        {(data.messages ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          (data.messages ?? []).map((m) => (
            <div
              key={m.id}
              className={`rounded-md border p-3 text-sm ${
                m.isInternal
                  ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
                  : "border-border bg-background"
              }`}
            >
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  <span className="font-medium text-foreground">
                    {m.senderName || titleCase(m.senderRole)}
                  </span>{" "}
                  · {titleCase(m.senderRole)}
                  {m.isInternal ? " · internal note" : ""}
                </span>
                <span>{formatDateTime(m.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2 rounded-md border border-border bg-background p-3">
        <textarea
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={isInternal ? "Internal note — the reporter never sees this" : "Reply to the reporter…"}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={isInternal}
              onChange={(e) => setIsInternal(e.target.checked)}
            />
            Internal note
          </label>
          <button
            type="button"
            disabled={busy || !content.trim()}
            onClick={() => void send()}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
          >
            {isInternal ? "Add note" : "Send reply"}
          </button>
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function TicketsTab() {
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [category, setCategory] = useState("");
  const [assignee, setAssignee] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading, mutate } = useSWR<Paginated<SupportTicket>>(
    ["/support/tickets", { status, priority, category, assignee, page: 1, limit: 50 }],
    swrFetcher,
    { refreshInterval: 30_000 },
  );
  // Staff roster powers both the assignee filter and the per-ticket assign picker.
  const { data: staffData } = useSWR<{ data: StaffLite[] }>(
    ["/staff", { portal: "admin", limit: 100 }],
    swrFetcher,
  );
  const staff = staffData?.data ?? [];

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
      <StatsRow />
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
      <div className="flex flex-wrap gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Any priority</option>
          {TICKET_PRIORITIES.map((p) => (
            <option key={p} value={p}>{titleCase(p)}</option>
          ))}
        </select>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Any category</option>
          {TICKET_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{titleCase(cat)}</option>
          ))}
        </select>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Any assignee</option>
          {staff.map((s) => (
            <option key={s.userId} value={s.userId}>{staffLabel(s)}</option>
          ))}
        </select>
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
                <Fragment key={t.id}>
                  <tr className="cursor-pointer hover:bg-muted/30" onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                    <td className="px-4 py-3 font-mono text-xs">
                      <span className="mr-1 text-muted-foreground">{openId === t.id ? "▾" : "▸"}</span>
                      {t.ticketNumber || t.id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 max-w-xs truncate">{t.subject}</td>
                    <td className="px-4 py-3 text-muted-foreground">{titleCase(t.category)}</td>
                    <td className="px-4 py-3"><StatusBadge label={titleCase(t.priority)} tone={priorityTone(t.priority)} /></td>
                    <td className="px-4 py-3"><StatusBadge label={titleCase(t.status)} tone={ticketTone(t.status)} /></td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(t.createdAt)}</td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
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
                  {openId === t.id ? (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <TicketDetail ticketId={t.id} staff={staff} onChanged={() => void mutate()} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
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
