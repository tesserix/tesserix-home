"use client";

import Link from "next/link";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { formatNumber } from "@/components/admin/metrics/format";

interface Summary {
  total: number;
  mfaEnrolled: number;
  stale90d: number;
  usedThisWeek: number;
}

interface Row {
  tenant_id: string;
  secret_path: string;
  totp_enrolled: boolean;
  last_rotated_at: string | null;
  last_used_at: string | null;
  rotation_scheduled_at: string | null;
  created_at: string;
  tenant_name: string | null;
  days_since_rotation: number | null;
  days_since_use: number | null;
}

interface Response {
  summary: Summary;
  rows: Row[];
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const STALE_DAYS = 90;
const RECENT_USE_DAYS = 7;

export default function BreakGlassPage() {
  const { data, error, isLoading } = useSWR<Response>(
    "/api/admin/break-glass",
    fetcher,
    { revalidateOnFocus: false },
  );
  const s = data?.summary;
  const mfaPct =
    s && s.total > 0 ? Math.round((s.mfaEnrolled / s.total) * 100) : null;

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Break-glass accounts"
        description="Mark8ly emergency-access accounts. Rotate every 90 days. Any usage in the last 7 days is investigation-worthy."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile
            label="Total accounts"
            value={s ? formatNumber(s.total) : "—"}
            hint="across mark8ly tenants"
            loading={isLoading}
          />
          <KpiTile
            label="MFA enrolled"
            value={
              s
                ? `${formatNumber(s.mfaEnrolled)}${mfaPct !== null ? ` · ${mfaPct}%` : ""}`
                : "—"
            }
            hint="TOTP configured"
            loading={isLoading}
          />
          <KpiTile
            label="Stale 90d+"
            value={s ? formatNumber(s.stale90d) : "—"}
            hint="needs rotation"
            loading={isLoading}
          />
          <KpiTile
            label="Used this week"
            value={s ? formatNumber(s.usedThisWeek) : "—"}
            hint="last 7 days"
            loading={isLoading}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load break-glass accounts.
          </div>
        )}

        {s && s.usedThisWeek > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
            <strong>{s.usedThisWeek}</strong> account{s.usedThisWeek === 1 ? "" : "s"}{" "}
            used in the last {RECENT_USE_DAYS} days. Confirm each was a
            legitimate emergency-access event and rotate.
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Tenant</th>
                <th className="px-4 py-3">Secret path</th>
                <th className="px-4 py-3">MFA</th>
                <th className="px-4 py-3">Last rotated</th>
                <th className="px-4 py-3">Last used</th>
                <th className="px-4 py-3">Rotation due</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).length === 0 && !isLoading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    No break-glass accounts.
                  </td>
                </tr>
              ) : (
                data?.rows.map((r) => {
                  const stale =
                    r.days_since_rotation === null ||
                    r.days_since_rotation >= STALE_DAYS;
                  const recentlyUsed =
                    r.days_since_use !== null &&
                    r.days_since_use <= RECENT_USE_DAYS;
                  return (
                    <tr
                      key={`${r.tenant_id}-${r.secret_path}`}
                      className="border-b border-border last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/apps/mark8ly/tenants/${r.tenant_id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {r.tenant_name ?? r.tenant_id.slice(0, 8) + "…"}
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {r.secret_path}
                      </td>
                      <td className="px-4 py-3">
                        {r.totp_enrolled ? (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700">
                            enrolled
                          </span>
                        ) : (
                          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-xs text-rose-700">
                            none
                          </span>
                        )}
                      </td>
                      <td
                        className={
                          "px-4 py-3 text-xs tabular-nums " +
                          (stale ? "font-semibold text-rose-700" : "text-muted-foreground")
                        }
                      >
                        {formatDays(r.days_since_rotation)}
                        {stale && (
                          <span className="ml-1 text-[10px] uppercase tracking-wide">
                            stale
                          </span>
                        )}
                      </td>
                      <td
                        className={
                          "px-4 py-3 text-xs tabular-nums " +
                          (recentlyUsed
                            ? "font-semibold text-amber-700"
                            : "text-muted-foreground")
                        }
                      >
                        {formatDays(r.days_since_use) || "never"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                        {r.rotation_scheduled_at
                          ? new Date(r.rotation_scheduled_at).toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatDays(days: number | null): string {
  if (days === null) return "";
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}
