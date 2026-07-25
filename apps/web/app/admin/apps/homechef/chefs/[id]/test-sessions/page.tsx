"use client";

// Debugging sessions for one kitchen.
//
// Every live→test flip opens a numbered session and clones the kitchen's setup
// plus recent orders into it, so a previous investigation's evidence is never
// overwritten by the next one. Closed sessions can be purged explicitly; open
// ones cannot, because that would delete rows out from under a kitchen that is
// still operating in them.

import { use, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Button } from "@tesserix/web";

import { formatDateTime, type ChefTestSession } from "@tesserix/homechef-shared";
import { GatewayError, hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";

function sessionTone(status: ChefTestSession["status"]): Tone {
  if (status === "open") return "warning";
  if (status === "purged") return "neutral";
  return "info";
}

/** Renders the clone's per-table row counts as "42 menu_items · 118 orders". */
function CloneSummary({ raw }: { raw?: string }) {
  if (!raw) return <span className="text-muted-foreground">—</span>;
  let parsed: Record<string, number>;
  try {
    parsed = JSON.parse(raw) as Record<string, number>;
  } catch {
    return <span className="text-muted-foreground">—</span>;
  }
  const parts = Object.entries(parsed).filter(([, n]) => n > 0);
  if (parts.length === 0) return <span className="text-muted-foreground">nothing cloned</span>;
  return (
    <span className="tabular-nums">
      {parts.map(([table, n]) => `${n} ${table}`).join(" · ")}
    </span>
  );
}

export default function ChefTestSessionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { confirm } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, mutate } = useSWR<{ sessions: ChefTestSession[] }>(
    [`/chefs/${id}/test-sessions`],
    swrFetcher,
  );
  const sessions = data?.sessions ?? [];

  async function purge(s: ChefTestSession) {
    const ok = await confirm({
      title: `Purge session ${s.sessionNo}`,
      message:
        "Every row this session created — cloned orders, menu items and anything done in the " +
        "sandbox — will be deleted permanently. The kitchen's live data is not touched.",
      confirmLabel: "Purge session",
      tone: "destructive",
    });
    if (!ok) return;

    setError(null);
    setBusyId(s.id);
    try {
      await hcAdmin.delete(`/test-sessions/${s.id}`);
      await mutate();
    } catch (e) {
      setError(
        e instanceof GatewayError && e.status === 409
          ? "Close the session before purging it."
          : e instanceof Error
            ? e.message
            : "Purge failed",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link
          href="/admin/apps/homechef/chefs"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Chefs
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">Test sessions</h1>
        <p className="text-sm text-muted-foreground">
          Each session is one debugging episode. Sessions are kept after they close so you can look
          back at what happened.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This kitchen has never been moved to test mode.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">#</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Reason</th>
                <th className="px-4 py-2">Cloned</th>
                <th className="px-4 py-2">Opened</th>
                <th className="px-4 py-2">Closed</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3 tabular-nums font-medium">{s.sessionNo}</td>
                  <td className="px-4 py-3">
                    <StatusBadge label={s.status} tone={sessionTone(s.status)} />
                  </td>
                  <td className="max-w-xs px-4 py-3 text-muted-foreground">{s.reason || "—"}</td>
                  <td className="px-4 py-3 text-xs">
                    <CloneSummary raw={s.cloneSummary} />
                    {s.orderWindowDays ? (
                      <div className="text-muted-foreground">
                        last {s.orderWindowDays} days of orders
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDateTime(s.openedAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {s.closedAt ? formatDateTime(s.closedAt) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {s.status === "closed" && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busyId === s.id}
                        onClick={() => purge(s)}
                      >
                        Purge
                      </Button>
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
