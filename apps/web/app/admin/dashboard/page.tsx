// Super-admin dashboard. Renders cross-product counts from
// /api/admin/dashboard, which itself reads live from tesserix-postgres
// (apps + leads) and mark8ly-postgres (tenants + stores via the
// mark8ly_platform_admin role).
//
// This server component owns only the live data fetch; the KPI row and the
// recharts pipeline visuals live in the client `DashboardContent`.

import { headers } from "next/headers";

import { AdminHeader } from "@/components/admin/header";
import { DashboardContent, type DashboardData } from "./dashboard-content";

async function loadDashboard(): Promise<DashboardData | null> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const cookie = h.get("cookie") ?? "";
  try {
    const res = await fetch(`${proto}://${host}/api/admin/dashboard`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as DashboardData;
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  const data = await loadDashboard();

  if (!data) {
    return (
      <div className="flex h-full flex-col">
        <AdminHeader title="Dashboard" />
        <div className="flex-1 p-6">
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 text-sm">
            Could not load dashboard data. Check the{" "}
            <code className="font-mono">/api/admin/dashboard</code> route and the
            cross-DB role status.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Dashboard" />
      <div className="flex-1 p-6">
        <DashboardContent data={data} />
      </div>
    </div>
  );
}
