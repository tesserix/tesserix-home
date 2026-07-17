"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { AlertTriangle } from "lucide-react";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import type {
  ApprovalPriority,
  ApprovalRequest,
  ApprovalStatus,
  Paginated,
} from "@/lib/products/homechef/contracts";

const STATUSES: { key: ApprovalStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "info_requested", label: "Info requested" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

// #697 — the escalated panel is a TAB here rather than its own page. It is the
// same queue, filtered; a separate route would duplicate the table, the fetch and
// the Review link, and would drift.
type Tab = ApprovalStatus | "escalated";

const ESCALATED: Tab = "escalated";

// How long a request has been waiting, phrased for triage.
function waitedFor(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3_600_000);
  return `${Math.max(hrs, 0)}h`;
}

function priorityTone(p: ApprovalPriority): Tone {
  if (p === "urgent") return "danger";
  if (p === "high") return "warning";
  if (p === "low") return "neutral";
  return "info";
}

export default function HomechefApprovalsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const escalatedView = tab === ESCALATED;

  // Escalated is deliberately NOT status-filtered: a chef chases a request
  // whatever state it is in, and hiding an escalated info_requested item behind a
  // status tab is how it would go quiet again.
  const { data, isLoading } = useSWR<Paginated<ApprovalRequest>>(
    escalatedView
      ? ["/approvals", { escalated: "true", page: 1, limit: 50 }]
      : ["/approvals", { status: tab, page: 1, limit: 50 }],
    swrFetcher,
  );
  const items = data?.data ?? [];

  // Badge the tab so an escalation is visible without opening it. Cheap: the
  // count comes back with the list.
  const { data: escalatedData } = useSWR<Paginated<ApprovalRequest>>(
    ["/approvals", { escalated: "true", page: 1, limit: 1 }],
    swrFetcher,
  );
  const escalatedCount = escalatedData?.pagination.total ?? 0;

  return (
    // pb-28 keeps the last row's "Review" link clear of the fixed
    // "Chat with support" widget that floats over the bottom-right corner.
    <div className="space-y-6 p-6 pb-28">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          {escalatedView
            ? "Chefs have chased these repeatedly — we have been slow, not them"
            : data
              ? `${data.pagination.total} ${titleCase(tab)}`
              : "Review queue"}
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => setTab(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === s.key
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            }`}
          >
            {s.label}
          </button>
        ))}
        {/* Escalated sits apart and carries a count: it is the one tab that means
            somebody is waiting on us. */}
        <button
          onClick={() => setTab(ESCALATED)}
          className={`ml-1 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
            escalatedView
              ? "bg-red-600 text-white"
              : escalatedCount > 0
                ? "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950 dark:text-red-300"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Escalated
          {escalatedCount > 0 ? (
            <span
              className={`rounded-full px-1.5 text-xs font-semibold ${
                escalatedView ? "bg-white/20" : "bg-red-600 text-white"
              }`}
            >
              {escalatedCount}
            </span>
          ) : null}
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Request</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Chased</th>
              <th className="px-4 py-3">Submitted</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  {escalatedView ? "Nothing escalated — nobody is waiting on us." : "Nothing in this state."}
                </td>
              </tr>
            ) : (
              items.map((a) => (
                <tr key={a.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      {a.escalatedAt ? (
                        <AlertTriangle
                          className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400"
                          aria-label="Escalated"
                        />
                      ) : null}
                      {a.title || titleCase(a.type)}
                    </div>
                    {a.kitchenName || a.requestedByName ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {[a.kitchenName, a.requestedByName].filter(Boolean).join(" · ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{titleCase(a.type)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge label={titleCase(a.priority)} tone={priorityTone(a.priority)} />
                  </td>
                  <td className="px-4 py-3">
                    {a.reminderCount && a.reminderCount > 0 ? (
                      <span
                        className={
                          a.escalatedAt
                            ? "font-semibold text-red-600 dark:text-red-400"
                            : "text-muted-foreground"
                        }
                      >
                        {a.reminderCount}× · waiting {waitedFor(a.createdAt)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDateTime(a.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/apps/homechef/approvals/${a.id}`}
                      className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Review →
                    </Link>
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
