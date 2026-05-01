"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";

interface Tenant {
  id: string;
  name: string;
  owner_user_id: string;
  owner_email: string;
  status: "active" | "suspended" | "archived";
  created_at: string;
  updated_at: string;
}

const STATUS_OPTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "archived", label: "Archived" },
];

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = filter === "all" ? "/api/admin/tenants" : `/api/admin/tenants?status=${filter}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { tenants: Tenant[] };
      setTenants(data.tenants);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateStatus = useCallback(
    async (id: string, status: string) => {
      const ok = window.confirm(`Change tenant status to "${status}"?`);
      if (!ok) return;
      const res = await fetch(`/api/admin/tenants/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) await refresh();
    },
    [refresh],
  );

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Tenants" />
      <div className="flex-1 space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={
                  "rounded-full border px-3 py-1 text-xs transition-colors " +
                  (filter === f.value
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:border-foreground/40")
                }
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:border-foreground/40"
          >
            <RefreshCw className={"h-3 w-3 " + (loading ? "animate-spin" : "")} />
            Refresh
          </button>
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Error: {error}
          </div>
        ) : null}

        <div className="rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Owner email</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.length === 0 && !loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No tenants.
                  </td>
                </tr>
              ) : (
                tenants.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-medium">{t.name}</td>
                    <td className="px-4 py-3 font-mono text-xs">{t.owner_email}</td>
                    <td className="px-4 py-3 capitalize">
                      <span
                        className={
                          "inline-block rounded-full px-2 py-0.5 text-xs " +
                          (t.status === "active"
                            ? "bg-emerald-500/15 text-emerald-700"
                            : t.status === "suspended"
                            ? "bg-amber-500/15 text-amber-700"
                            : "bg-muted text-muted-foreground")
                        }
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(t.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <select
                        value={t.status}
                        onChange={(e) => void updateStatus(t.id, e.target.value)}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        <option value="active">active</option>
                        <option value="suspended">suspended</option>
                        <option value="archived">archived</option>
                      </select>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
