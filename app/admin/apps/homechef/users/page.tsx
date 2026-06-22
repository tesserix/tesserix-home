"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatINR, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge } from "@/components/admin/homechef/status-badge";
import type { Paginated, UserWithStats } from "@/lib/products/homechef/contracts";

const ROLES = [
  { key: "", label: "All" },
  { key: "customer", label: "Customers" },
  { key: "chef", label: "Chefs" },
  { key: "delivery", label: "Drivers" },
  { key: "admin", label: "Admins" },
];

export default function HomechefUsersPage() {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, mutate } = useSWR<Paginated<UserWithStats>>(
    ["/users", { search, role, page: 1, limit: 50 }],
    swrFetcher,
  );

  async function toggle(u: UserWithStats) {
    const action = u.isActive ? "suspend" : "activate";
    if (!window.confirm(`${titleCase(action)} ${u.email}?`)) return;
    setError(null);
    setBusyId(u.id);
    try {
      await hcAdmin.put(`/users/${u.id}/${action}`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const users = data?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Users</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.total} registered` : "All accounts"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email…"
          className="h-9 w-72 rounded-md border border-border bg-background px-3 text-sm"
        />
        <div className="flex gap-1">
          {ROLES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRole(r.key)}
              className={`rounded-md px-3 py-1.5 text-sm ${
                role === r.key
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {r.label}
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
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Orders</th>
              <th className="px-4 py-3">Spent</th>
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
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const name = `${u.firstName} ${u.lastName}`.trim() || u.email;
                const busy = busyId === u.id;
                return (
                  <tr key={u.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{name}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{titleCase(u.role)}</td>
                    <td className="px-4 py-3 tabular-nums">{u.totalOrders}</td>
                    <td className="px-4 py-3 tabular-nums">{formatINR(u.totalSpent)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        label={u.isActive ? "Active" : "Suspended"}
                        tone={u.isActive ? "success" : "danger"}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/admin/apps/homechef/wallets?userId=${u.id}`}
                          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70"
                        >
                          Wallet
                        </Link>
                        <Button
                          size="sm"
                          variant={u.isActive ? "destructive" : "default"}
                          disabled={busy}
                          onClick={() => toggle(u)}
                        >
                          {u.isActive ? "Suspend" : "Activate"}
                        </Button>
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
