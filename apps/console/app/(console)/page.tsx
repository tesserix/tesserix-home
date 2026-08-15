import { cookies } from "next/headers";
import { EstateMap } from "@/components/estate-map";
import { InternalTools } from "@/components/internal-tools";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { StatTile } from "@/components/kit/stat-tile";
import { NOT_IMPLEMENTED, type SurfaceState } from "@/components/kit/states";
import {
  PlatformApiError,
  fetchDashboard,
  type PlatformDashboard,
} from "@/lib/platform-api";

export function dashboardState(error: unknown): SurfaceState {
  if (error === null || error === undefined) return { kind: "ready" };
  if (error instanceof PlatformApiError && error.status === NOT_IMPLEMENTED) {
    return { kind: "instrumentation-unavailable" };
  }
  return {
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function DashboardView({
  data,
  state,
}: {
  data: PlatformDashboard | null;
  state: SurfaceState;
}) {
  if (state.kind !== "ready" || data === null) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Tenants" value="" state={state} />
        <StatTile label="Stores" value="" state={state} />
        <StatTile label="Active apps" value="" state={state} />
        <StatTile label="Leads" value="" state={state} />
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Tenants"
        value={data.tenants.total}
        delta={`${data.tenants.active} active`}
      />
      <StatTile label="Stores" value={data.stores.total} />
      <StatTile label="Active apps" value={data.apps.active} />
      <StatTile
        label="Leads"
        value={data.leads.total}
        delta={`${data.leads.by_status.new} new`}
      />
    </div>
  );
}

export default async function ConsoleHome() {
  const cookieHeader = (await cookies()).toString();

  let data: PlatformDashboard | null = null;
  let error: unknown = null;
  try {
    data = await fetchDashboard(cookieHeader);
  } catch (caught) {
    error = caught;
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Platform"
        description="The estate at a glance."
      />
      {/* These four are MARK8LY'S numbers — tenants, stores and leads all come
          from its database — and were labelled "estate health across every
          product", which they are not. Saying whose they are is the honest
          interim state until #133 replaces this with the cross-product ticket
          queue: a wrong label is worse than a narrow one, because a reader
          cannot tell it is wrong. */}
      <section className="flex flex-col gap-2" aria-labelledby="mark8ly-stats">
        <h2
          id="mark8ly-stats"
          className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
        >
          Mark8ly
        </h2>
        <DashboardView data={data} state={dashboardState(error)} />
      </section>
      <EstateMap />
      {/* Base domain is configuration, not a constant: a non-production console
          must not hand operators links into production tools. */}
      <InternalTools baseDomain={process.env.NEXT_PUBLIC_TOOLS_DOMAIN ?? "tesserix.app"} />
    </div>
  );
}
