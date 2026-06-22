"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatINR } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type { ChefWithStats, Paginated } from "@/lib/products/homechef/contracts";

const STATUS_FILTERS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "verified", label: "Verified" },
  { key: "suspended", label: "Suspended" },
];

function chefStatus(c: ChefWithStats): { label: string; tone: Tone } {
  if (!c.isVerified) return { label: "Pending", tone: "warning" };
  if (!c.isActive) return { label: "Suspended", tone: "danger" };
  return { label: "Verified", tone: "success" };
}

export default function HomechefChefsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, prompt } = useConfirm();

  const { data, isLoading, mutate } = useSWR<Paginated<ChefWithStats>>(
    ["/chefs", { search, status, page: 1, limit: 50 }],
    swrFetcher,
  );

  async function act(id: string, action: "verify" | "suspend" | "reject") {
    setError(null);
    let reason = "";
    if (action === "reject") {
      const r = await prompt({
        title: "Reject application",
        message: "Tell the chef why their application was rejected.",
        label: "Reason",
        placeholder: "e.g. FSSAI licence missing / not a home kitchen",
        multiline: true,
        required: true,
        confirmLabel: "Reject application",
        tone: "destructive",
      });
      if (r === null) return;
      reason = r;
    } else {
      const ok = await confirm({
        title: action === "verify" ? "Verify kitchen" : "Suspend kitchen",
        message:
          action === "verify"
            ? "Approve this home kitchen? It will go live and can receive orders."
            : "Suspend this kitchen? It will stop receiving orders immediately.",
        confirmLabel: action === "verify" ? "Verify" : "Suspend",
        tone: action === "suspend" ? "destructive" : "default",
      });
      if (!ok) return;
    }
    setBusyId(id);
    try {
      await hcAdmin.put(`/chefs/${id}/${action}`, action === "reject" ? { reason } : undefined);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const chefs = data?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Chefs / Kitchens</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.total} home kitchens` : "Home kitchens"} · verify, reject &
          suspend
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by business or owner…"
          className="h-9 w-72 rounded-md border border-border bg-background px-3 text-sm"
        />
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
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
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Kitchen</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Orders</th>
              <th className="px-4 py-3">Revenue</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : chefs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  No chefs found.
                </td>
              </tr>
            ) : (
              chefs.map((c) => {
                const s = chefStatus(c);
                const busy = busyId === c.id;
                return (
                  <tr key={c.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">
                        {c.businessName || "Unnamed kitchen"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {c.rating?.toFixed(1) ?? "0.0"}★ · {c.menuItemCount} items
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-foreground">{c.ownerName || "—"}</div>
                      <div className="text-xs text-muted-foreground">{c.ownerEmail}</div>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{c.totalOrders}</td>
                    <td className="px-4 py-3 tabular-nums">{formatINR(c.totalRevenue)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge label={s.label} tone={s.tone} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {!c.isVerified ? (
                          <>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => act(c.id, "verify")}
                            >
                              Verify
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => act(c.id, "reject")}
                            >
                              Reject
                            </Button>
                          </>
                        ) : c.isActive ? (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => act(c.id, "suspend")}
                          >
                            Suspend
                          </Button>
                        ) : (
                          <Button size="sm" disabled={busy} onClick={() => act(c.id, "verify")}>
                            Reinstate
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
