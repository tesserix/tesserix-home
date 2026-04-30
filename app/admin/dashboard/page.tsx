// Super-admin dashboard. Renders cross-product counts from
// /api/admin/dashboard, which itself reads live from tesserix-postgres
// (apps + leads) and mark8ly-postgres (tenants + stores via the
// mark8ly_platform_admin role).

import Link from "next/link";
import { headers } from "next/headers";
import { Building2, Store, Users, Boxes, ArrowRight } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";

interface DashboardData {
  tenants: { total: number; active: number };
  stores: { total: number };
  leads: { total: number; by_status: Record<string, number> };
  apps: { active: number };
  generated_at: string;
}

const LEAD_STATUS_ORDER: ReadonlyArray<string> = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
];

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

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  hint?: string;
}

function StatCard({ label, value, icon: Icon, href, hint }: StatCardProps) {
  const inner = (
    <div className="rounded-lg border border-border bg-card p-5 transition-colors hover:border-foreground/30">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      {href ? (
        <div className="mt-4 flex items-center gap-1 text-sm text-foreground">
          View <ArrowRight className="h-3 w-3" />
        </div>
      ) : null}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

interface LeadFunnelProps {
  byStatus: Record<string, number>;
  total: number;
}

function LeadFunnel({ byStatus, total }: LeadFunnelProps) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <header className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium">Leads pipeline</h2>
        <Link
          href="/admin/leads"
          className="flex items-center gap-1 text-sm text-foreground/70 hover:text-foreground"
        >
          Manage <ArrowRight className="h-3 w-3" />
        </Link>
      </header>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          No leads yet. Import a CSV or paste-JSON dump on the leads page to populate the pipeline.
        </p>
      ) : (
        <ul className="space-y-2">
          {LEAD_STATUS_ORDER.map((status) => {
            const count = byStatus[status] ?? 0;
            const pct = total > 0 ? Math.round((count / total) * 100) : 0;
            return (
              <li key={status} className="flex items-center gap-3">
                <span className="w-24 text-sm capitalize text-muted-foreground">{status}</span>
                <div className="flex-1">
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-foreground/70" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <span className="w-12 text-right text-sm tabular-nums">{count}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default async function DashboardPage() {
  const data = await loadDashboard();

  if (!data) {
    return (
      <div className="flex h-full flex-col">
        <AdminHeader title="Dashboard" />
        <div className="flex-1 p-6">
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 text-sm">
            Could not load dashboard data. Check the <code className="font-mono">/api/admin/dashboard</code> route and the cross-DB role status.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Dashboard" />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Active tenants" value={data.tenants.active} hint={`${data.tenants.total} total`} icon={Users} href="/admin/tenants" />
          <StatCard label="Stores" value={data.stores.total} icon={Store} href="/admin/tenants" />
          <StatCard label="Active products" value={data.apps.active} icon={Boxes} href="/admin/apps" />
          <StatCard label="Leads" value={data.leads.total} icon={Building2} href="/admin/leads" />
        </div>
        <LeadFunnel byStatus={data.leads.by_status} total={data.leads.total} />
        <p className="text-xs text-muted-foreground">
          Generated at <time dateTime={data.generated_at}>{new Date(data.generated_at).toLocaleString()}</time>
        </p>
      </div>
    </div>
  );
}
