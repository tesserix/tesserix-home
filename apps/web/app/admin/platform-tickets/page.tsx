"use client";

import useSWR from "swr";
import Link from "next/link";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { formatNumber } from "@/components/admin/metrics/format";

interface TicketRow {
  id: string;
  product_id: string;
  tenant_id: string;
  ticket_number: string;
  subject: string;
  status: string;
  priority: string;
  submitted_by_email: string;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  summary: { open: number; inProgress: number; resolvedThisWeek: number; urgentOpen: number };
  rows: TicketRow[];
}

const fetcher = (u: string) => fetch(u, { credentials: "include" }).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

const STATUS_TONE: Record<string, string> = {
  open: "bg-sky-500/15 text-sky-700",
  in_progress: "bg-amber-500/15 text-amber-700",
  resolved: "bg-emerald-500/15 text-emerald-700",
  closed: "bg-muted text-muted-foreground",
};

const PRIORITY_TONE: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-foreground",
  high: "text-amber-700 font-medium",
  urgent: "text-rose-700 font-semibold",
};

export default function PlatformTicketsPage() {
  const { data, error, isLoading } = useSWR<ListResponse>("/api/admin/platform-tickets", fetcher, { revalidateOnFocus: false });
  const isEmpty = !isLoading && !error && (data?.rows ?? []).length === 0;

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Platform tickets" />
      <div className="flex-1 space-y-6 p-6">
        <p className="text-sm text-muted-foreground">
          Merchant → Tesserix support tickets. Filing UI ships in mark8ly admin (Phase 5.5); this list will populate once that lands.
        </p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile label="Open" value={data ? formatNumber(data.summary.open) : "—"} hint={isEmpty ? "no data yet" : undefined} loading={isLoading} />
          <KpiTile label="In progress" value={data ? formatNumber(data.summary.inProgress) : "—"} hint={isEmpty ? "no data yet" : undefined} loading={isLoading} />
          <KpiTile label="Urgent (open)" value={data ? formatNumber(data.summary.urgentOpen) : "—"} hint={isEmpty ? "no data yet" : undefined} loading={isLoading} />
          <KpiTile label="Resolved (7d)" value={data ? formatNumber(data.summary.resolvedThisWeek) : "—"} hint={isEmpty ? "no data yet" : undefined} loading={isLoading} />
        </div>
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">Could not load tickets.</div>
        ) : null}
        {isEmpty ? (
          <EmptyState>
            <EmptyStateIcon>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="h-6 w-6"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l4.414 4.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2Z"
                />
              </svg>
            </EmptyStateIcon>
            <EmptyStateTitle>No platform tickets yet</EmptyStateTitle>
            <EmptyStateDescription>
              Merchant ticket filing ships with mark8ly admin (Phase 5.5). This list populates once that&apos;s live —
              there&apos;s nothing wrong today, there&apos;s just nothing to show yet.
            </EmptyStateDescription>
          </EmptyState>
        ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Number</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Submitter</th>
                <th className="px-4 py-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link href={`/admin/platform-tickets/${r.id}`} className="hover:underline">
                        {r.ticket_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs capitalize">{r.product_id}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/platform-tickets/${r.id}`} className="hover:underline">
                        {r.subject}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[r.status] ?? "bg-muted"}`}>{r.status}</span>
                    </td>
                    <td className={`px-4 py-3 text-xs capitalize ${PRIORITY_TONE[r.priority]}`}>{r.priority}</td>
                    <td className="px-4 py-3 font-mono text-xs">{r.submitted_by_email}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(r.updated_at).toLocaleString()}</td>
                  </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>
  );
}
