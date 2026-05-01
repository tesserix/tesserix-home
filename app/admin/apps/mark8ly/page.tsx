import Link from "next/link";
import { headers } from "next/headers";
import { ArrowRight, Building2, Users } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";

interface DashboardData {
  tenants: { total: number; active: number };
  stores: { total: number };
  leads: { total: number };
}

async function loadOverview(): Promise<DashboardData | null> {
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

interface SectionCardProps {
  label: string;
  value: number | string;
  hint?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

function SectionCard({ label, value, hint, href, icon: Icon }: SectionCardProps) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-border bg-card p-5 transition-colors hover:border-foreground/30"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="mt-4 flex items-center gap-1 text-sm text-foreground">
        Open <ArrowRight className="h-3 w-3" />
      </div>
    </Link>
  );
}

export default async function Mark8lyOverviewPage() {
  const data = await loadOverview();

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Mark8ly" />
      <div className="flex-1 space-y-6 p-6">
        <p className="text-sm text-muted-foreground">
          Mark8ly product overview. Tenants and leads are sourced live from mark8ly-postgres.
        </p>

        {data ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <SectionCard
              label="Active tenants"
              value={data.tenants.active}
              hint={`${data.tenants.total} total`}
              href="/admin/apps/mark8ly/tenants"
              icon={Users}
            />
            <SectionCard
              label="Stores"
              value={data.stores.total}
              href="/admin/apps/mark8ly/tenants"
              icon={Users}
            />
            <SectionCard
              label="Leads"
              value={data.leads.total}
              href="/admin/apps/mark8ly/leads"
              icon={Building2}
            />
          </div>
        ) : (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load Mark8ly overview. Check <code className="font-mono">/api/admin/dashboard</code> and the cross-DB role status.
          </div>
        )}
      </div>
    </div>
  );
}
