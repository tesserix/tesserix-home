"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";

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

function priorityTone(p: ApprovalPriority): Tone {
  if (p === "urgent") return "danger";
  if (p === "high") return "warning";
  if (p === "low") return "neutral";
  return "info";
}

export default function HomechefApprovalsPage() {
  const [status, setStatus] = useState<ApprovalStatus>("pending");
  const { data, isLoading } = useSWR<Paginated<ApprovalRequest>>(
    ["/approvals", { status, page: 1, limit: 50 }],
    swrFetcher,
  );
  const items = data?.data ?? [];

  return (
    // pb-28 keeps the last row's "Review" link clear of the fixed
    // "Chat with support" widget that floats over the bottom-right corner.
    <div className="space-y-6 p-6 pb-28">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.total} ${titleCase(status)}` : "Review queue"}
        </p>
      </div>

      <div className="flex gap-1">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => setStatus(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              status === s.key
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Request</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Submitted</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  Nothing in this state.
                </td>
              </tr>
            ) : (
              items.map((a) => (
                <tr key={a.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">
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
