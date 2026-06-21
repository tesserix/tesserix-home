"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDate, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge } from "@/components/admin/homechef/status-badge";
import type { Paginated, StaffMember } from "@/lib/products/homechef/contracts";

const ROLES = ["support", "fleet_manager", "delivery_ops", "admin", "super_admin"];

export default function HomechefStaffPage() {
  const { data, isLoading, mutate } = useSWR<Paginated<StaffMember>>(
    ["/staff", { page: 1, limit: 50 }],
    swrFetcher,
  );
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("support");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  async function invite() {
    setError(null);
    if (!email.includes("@")) return setError("Enter a valid email.");
    setInviting(true);
    try {
      await hcAdmin.post("/staff/invitations", { email: email.trim(), staffRole: role });
      setEmail("");
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invite failed");
    } finally {
      setInviting(false);
    }
  }

  async function toggle(m: StaffMember) {
    const action = m.isActive ? "deactivate" : "reactivate";
    if (!window.confirm(`${titleCase(action)} ${m.user?.email ?? "this member"}?`)) return;
    setError(null);
    setBusyId(m.id);
    try {
      await hcAdmin.put(`/staff/${m.id}/${action}`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const staff = data?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Staff</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.total} team members` : "Internal team"}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-4">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@fe3dr.com"
          className="h-9 w-64 rounded-md border border-border bg-background px-3 text-sm"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {titleCase(r)}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={inviting} onClick={invite}>
          {inviting ? "Inviting…" : "Invite"}
        </Button>
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
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Joined</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : staff.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  No staff. Invite your first member above.
                </td>
              </tr>
            ) : (
              staff.map((m) => {
                const name =
                  m.user?.email ||
                  `${m.user?.firstName ?? ""} ${m.user?.lastName ?? ""}`.trim() ||
                  m.id.slice(0, 8);
                const busy = busyId === m.id;
                return (
                  <tr key={m.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{name}</div>
                      {m.title ? (
                        <div className="text-xs text-muted-foreground">{m.title}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{titleCase(m.staffRole)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(m.createdAt)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        label={m.isActive ? "Active" : "Inactive"}
                        tone={m.isActive ? "success" : "neutral"}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant={m.isActive ? "destructive" : "default"}
                        disabled={busy}
                        onClick={() => toggle(m)}
                      >
                        {m.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
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
