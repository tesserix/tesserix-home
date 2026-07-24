"use client";

// HomeChef AUDIT LOG. Who changed what, filterable by action, entity and date.
// Migrated from the HomeChef admin-portal into the unified Tesserix admin.
//
// This is the paper trail behind every other screen here — payout releases,
// refund resolutions, key swaps, policy edits. It matters more now that the
// unified admin is the single console for all of them, and more again given
// payout permission auto-provisions for super-admin emails: the audit row is
// the only place the acting person is recorded.
//
// Unlike the rest of the HomeChef admin this endpoint does NOT return the
// Paginated<T> envelope — it is a flat { logs, total, page, limit }.

import { useState } from "react";
import useSWR from "swr";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, titleCase } from "@/lib/products/homechef/format";
import type { AuditLogEntry, AuditLogResponse } from "@/lib/products/homechef/contracts";

const LIMIT = 50;

function actorLabel(row: AuditLogEntry): string {
  if (!row.user) {
    // No acting human — a cron or an internal service made this change.
    return row.userId ? row.userId.slice(0, 8) : "System";
  }
  const name = [row.user.firstName, row.user.lastName].filter(Boolean).join(" ").trim();
  return name || row.user.email || "—";
}

// old → new is the whole point of an audit row, but the values are opaque JSON
// blobs. Show them on demand rather than making every row unreadable.
function ChangeCell({ row }: { row: AuditLogEntry }) {
  const [open, setOpen] = useState(false);
  if (!row.oldValue && !row.newValue) return <span className="text-muted-foreground">—</span>;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs underline text-muted-foreground"
      >
        show
      </button>
    );
  }
  return (
    <div className="space-y-1">
      {row.oldValue ? (
        <pre className="max-w-md overflow-x-auto rounded bg-muted p-2 text-[11px]">
          - {row.oldValue}
        </pre>
      ) : null}
      {row.newValue ? (
        <pre className="max-w-md overflow-x-auto rounded bg-muted p-2 text-[11px]">
          + {row.newValue}
        </pre>
      ) : null}
      <button type="button" onClick={() => setOpen(false)} className="text-xs underline">
        hide
      </button>
    </div>
  );
}

export default function HomechefAuditLogsPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const { data, isLoading } = useSWR<AuditLogResponse>(
    [
      "/audit-logs",
      {
        page,
        limit: LIMIT,
        ...(action ? { action } : {}),
        ...(entityType ? { entityType } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
    ],
    swrFetcher,
  );

  const logs = data?.logs ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.limit || LIMIT))) : 1;

  // Any filter change invalidates the current page number.
  function applyFilter(fn: () => void) {
    fn();
    setPage(1);
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every change made through the admin — payout releases, refunds, key swaps, policy edits —
          and who made it.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 rounded-lg border p-4">
        <label className="space-y-1 text-sm">
          <span className="block font-medium">Action</span>
          <input
            className="rounded-md border px-3 py-2"
            value={action}
            onChange={(e) => applyFilter(() => setAction(e.target.value))}
            placeholder="e.g. chef.payout.update"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium">Entity</span>
          <input
            className="rounded-md border px-3 py-2"
            value={entityType}
            onChange={(e) => applyFilter(() => setEntityType(e.target.value))}
            placeholder="e.g. chef"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium">From</span>
          <input
            type="date"
            className="rounded-md border px-3 py-2"
            value={from}
            onChange={(e) => applyFilter(() => setFrom(e.target.value))}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium">To</span>
          <input
            type="date"
            className="rounded-md border px-3 py-2"
            value={to}
            onChange={(e) => applyFilter(() => setTo(e.target.value))}
          />
        </label>
        {action || entityType || from || to ? (
          <button
            type="button"
            onClick={() =>
              applyFilter(() => {
                setAction("");
                setEntityType("");
                setFrom("");
                setTo("");
              })
            }
            className="self-end rounded-md border px-3 py-2 text-sm"
          >
            Clear
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : logs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No audit events match these filters.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="p-3">When</th>
                  <th className="p-3">Who</th>
                  <th className="p-3">Action</th>
                  <th className="p-3">Entity</th>
                  <th className="p-3">Change</th>
                  <th className="p-3">IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 align-top">
                    <td className="p-3 whitespace-nowrap">{formatDateTime(row.createdAt)}</td>
                    <td className="p-3">{actorLabel(row)}</td>
                    <td className="p-3 font-mono text-xs">{row.action}</td>
                    <td className="p-3">
                      <div>{titleCase(row.entityType)}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {row.entityId ? row.entityId.slice(0, 8) : "—"}
                      </div>
                    </td>
                    <td className="p-3">
                      <ChangeCell row={row} />
                    </td>
                    <td className="p-3 font-mono text-xs text-muted-foreground">
                      {row.ipAddress || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {data?.total ?? 0} events · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-md border px-3 py-1 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded-md border px-3 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
