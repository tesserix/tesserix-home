import { cookies } from "next/headers";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { StatTile } from "@/components/kit/stat-tile";
import type { SurfaceState } from "@/components/kit/states";
import {
  PlatformApiError,
  fetchDashboard,
  type PlatformDashboard,
} from "@/lib/platform-api";

const NOT_IMPLEMENTED = 501;

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
        description="Estate health across every product."
      />
      <DashboardView data={data} state={dashboardState(error)} />
    </div>
  );
}
