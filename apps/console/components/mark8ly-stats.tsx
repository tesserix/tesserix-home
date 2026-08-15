import { StatTile } from "@/components/kit/stat-tile";
import { NOT_IMPLEMENTED, type SurfaceState } from "@/components/kit/states";
import {
  PlatformApiError,
  type PlatformDashboard,
} from "@/lib/platform-api";

/**
 * Mark8ly's business tiles — tenants, stores, active apps, leads.
 *
 * NOT rendered on the platform home. They are one product's numbers, and a
 * platform home leading with them is the mistake the console spec exists to
 * correct. Kept here, out of the page file, ready for Mark8ly's own rail.
 */

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
