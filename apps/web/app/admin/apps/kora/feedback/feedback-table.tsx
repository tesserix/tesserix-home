"use client";

import { useState, useTransition } from "react";

import { setFeedbackStatus } from "./actions";
import type { KoraFeedback } from "@/lib/api/kora-admin";

// "use client" because the status <select> mutates — matches the reasoning
// in the Kora foods form for why that page's edit surface is a client
// component while the index stays server-rendered.

const STATUS_VALUES = ["open", "in_progress", "resolved", "closed"] as const;

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

const KIND_LABEL: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
};

/**
 * Coarse relative-age string. Kora's operators care about "is this stale",
 * not clock precision, so this intentionally buckets rather than pulling in
 * a formatting library this app does not otherwise depend on.
 */
function formatAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * The submitter to show for a row. `display_name` may be "" for users
 * created before display-name seeding landed — falling through to email
 * keeps a row from ever rendering a blank submitter.
 */
function submitterLabel(item: KoraFeedback): string {
  return item.display_name || item.email || "Unknown user";
}

function StatusBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs uppercase text-muted-foreground">
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

function FeedbackRow({ item }: { item: KoraFeedback }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState(item.status);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onStatusChange(next: string) {
    const previous = status;
    setStatus(next);
    setError(null);
    startTransition(async () => {
      const result = await setFeedbackStatus(item.id, next);
      if (!result.ok) {
        // Revert the control to its previous value — an operator must never
        // be shown a status the server did not actually accept.
        setStatus(previous);
        setError(result.message);
      }
    });
  }

  return (
    <>
      <tr className="align-top hover:bg-muted/30">
        <td className="px-4 py-3">
          <StatusBadge kind={item.kind} />
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="text-left font-medium text-foreground underline-offset-2 hover:underline"
          >
            {item.subject || "(no subject)"}
          </button>
        </td>
        <td className="px-4 py-3 text-foreground">{submitterLabel(item)}</td>
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
          {formatAge(item.created_at)}
        </td>
        <td className="px-4 py-3">
          <select
            value={status}
            disabled={isPending}
            onChange={(e) => onStatusChange(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
          >
            {STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
          {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-muted/20">
          <td colSpan={5} className="px-4 py-4">
            <div className="space-y-3">
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {item.description || "(no description)"}
              </p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                <div>
                  <dt className="uppercase">App version</dt>
                  <dd className="text-foreground">{item.app_version || "—"}</dd>
                </div>
                <div>
                  <dt className="uppercase">Platform</dt>
                  <dd className="text-foreground">{item.platform || "—"}</dd>
                </div>
                <div>
                  <dt className="uppercase">OS version</dt>
                  <dd className="text-foreground">{item.os_version || "—"}</dd>
                </div>
                <div>
                  <dt className="uppercase">Device</dt>
                  <dd className="text-foreground">{item.device_model || "—"}</dd>
                </div>
              </dl>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function FeedbackTable({
  items,
  emptyLabel,
}: {
  items: KoraFeedback[];
  emptyLabel: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">Submitter</th>
              <th className="px-4 py-3">Age</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              items.map((item) => <FeedbackRow key={item.id} item={item} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
