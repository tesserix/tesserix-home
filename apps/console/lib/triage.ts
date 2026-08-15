import type { SurfaceState } from "@/components/kit/states";
import { PlatformApiError } from "./platform-api";

/**
 * The platform dashboard's triage signals, read from `apps/web`'s admin API.
 *
 * Deliberately NOT tenants/stores/leads — those are one product's business
 * numbers, not estate health. This surface answers "is anything broken", so it
 * reads the four things that can actually break: workloads, database clusters,
 * async delivery, and support load.
 */

const NOT_IMPLEMENTED = 501;

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new PlatformApiError(`triage: ${path} is missing`);
  }
  return value as Record<string, unknown>;
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlatformApiError(`triage: ${path} is not a number`);
  }
  return value;
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PlatformApiError(`triage: ${path} is not an array`);
  }
  return value;
}

/** Sources that can report themselves unmeasured carry this pair. */
export interface Availability {
  readonly available?: boolean;
  readonly errorMessage?: string | null;
}

export interface HealthTotals {
  readonly workloads: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly down: number;
}

export interface ServiceHealth extends Availability {
  readonly totals: HealthTotals;
  readonly workloads: ReadonlyArray<{
    readonly namespace: string;
    readonly workload: string;
    readonly status: string;
  }>;
}

export function parseServiceHealth(json: unknown): ServiceHealth {
  const root = obj(json, "serviceHealth");
  const totals = obj(root.totals, "serviceHealth.totals");
  return {
    totals: {
      workloads: num(totals.workloads, "serviceHealth.totals.workloads"),
      healthy: num(totals.healthy, "serviceHealth.totals.healthy"),
      degraded: num(totals.degraded, "serviceHealth.totals.degraded"),
      down: num(totals.down, "serviceHealth.totals.down"),
    },
    workloads: arr(root.workloads, "serviceHealth.workloads").map((raw, i) => {
      const w = obj(raw, `serviceHealth.workloads[${i}]`);
      return {
        namespace: String(w.namespace ?? ""),
        workload: String(w.workload ?? ""),
        status: String(w.status ?? "unknown"),
      };
    }),
    available: root.available !== false,
    errorMessage: typeof root.errorMessage === "string" ? root.errorMessage : null,
  };
}

export interface CnpgHealth extends Availability {
  readonly totals: { readonly clusters: number; readonly healthy: number; readonly degraded: number; readonly down: number };
  readonly clusters: ReadonlyArray<{ readonly namespace: string; readonly cluster: string; readonly status: string }>;
}

export function parseCnpgHealth(json: unknown): CnpgHealth {
  const root = obj(json, "cnpg");
  const totals = obj(root.totals, "cnpg.totals");
  return {
    totals: {
      clusters: num(totals.clusters, "cnpg.totals.clusters"),
      healthy: num(totals.healthy, "cnpg.totals.healthy"),
      degraded: num(totals.degraded, "cnpg.totals.degraded"),
      down: num(totals.down, "cnpg.totals.down"),
    },
    clusters: arr(root.clusters, "cnpg.clusters").map((raw, i) => {
      const c = obj(raw, `cnpg.clusters[${i}]`);
      return {
        namespace: String(c.namespace ?? ""),
        cluster: String(c.cluster ?? ""),
        status: String(c.status ?? "unknown"),
      };
    }),
    available: root.available !== false,
    errorMessage: typeof root.errorMessage === "string" ? root.errorMessage : null,
  };
}

export interface OutboxHealth {
  /** Stuck + dead across every database — the number that needs a human. */
  readonly needsAttention: number;
  readonly recent: ReadonlyArray<{
    readonly id: string;
    readonly database: string;
    readonly kind: string;
    readonly status: string;
    readonly lastError: string | null;
    readonly createdAt: string;
  }>;
}

export function parseOutbox(json: unknown): OutboxHealth {
  const root = obj(json, "outbox");
  let needsAttention = 0;
  for (const [i, raw] of arr(root.summaries, "outbox.summaries").entries()) {
    const s = obj(raw, `outbox.summaries[${i}]`);
    needsAttention +=
      num(s.stuck, `outbox.summaries[${i}].stuck`) + num(s.dead, `outbox.summaries[${i}].dead`);
  }
  return {
    needsAttention,
    recent: arr(root.recent, "outbox.recent").map((raw, i) => {
      const r = obj(raw, `outbox.recent[${i}]`);
      return {
        id: String(r.id ?? ""),
        database: String(r.database ?? ""),
        kind: String(r.kind ?? ""),
        status: String(r.status ?? ""),
        lastError: typeof r.lastError === "string" ? r.lastError : null,
        createdAt: String(r.createdAt ?? ""),
      };
    }),
  };
}

export interface TicketsHealth {
  readonly summary: {
    readonly open: number;
    readonly inProgress: number;
    readonly resolvedThisWeek: number;
    readonly urgentOpen: number;
  };
}

export function parseTickets(json: unknown): TicketsHealth {
  const root = obj(json, "tickets");
  const s = obj(root.summary, "tickets.summary");
  return {
    summary: {
      open: num(s.open, "tickets.summary.open"),
      inProgress: num(s.inProgress, "tickets.summary.inProgress"),
      resolvedThisWeek: num(s.resolvedThisWeek, "tickets.summary.resolvedThisWeek"),
      urgentOpen: num(s.urgentOpen, "tickets.summary.urgentOpen"),
    },
  };
}

/**
 * Resolve one tile's state.
 *
 * Two distinct ways a signal can be unmeasured, and both must land on
 * `instrumentation-unavailable`:
 *
 * 1. The transport says so — HTTP 501.
 * 2. **The payload says so** — a 200 carrying `available: false`, which is how
 *    `service-health` and `cnpg-health` report a parked Prometheus. Keying only
 *    off the status code would render a parked plane as healthy.
 *
 * Absence of the flag is NOT unavailability: tickets and outbox have no such
 * field and are perfectly measurable.
 */
export function triageState(error: unknown, data: Availability | null): SurfaceState {
  if (error instanceof PlatformApiError && error.status === NOT_IMPLEMENTED) {
    return { kind: "instrumentation-unavailable" };
  }
  if (error !== null && error !== undefined) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (data?.available === false) {
    return { kind: "instrumentation-unavailable" };
  }
  return { kind: "ready" };
}
