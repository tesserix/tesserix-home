// `server-only`: this reads an operator's bearer token via platformRequest.
// A client component importing it must fail the build, not ship server code
// to the browser — see #299 and the same header on lib/tools-directory.ts.
import "server-only";

import { platformApiOrigin, platformRequestWithMeta } from "@/lib/platform-api";

/** The three states, spelled exactly as the Go module spells them. */
export type HealthState = "healthy" | "degraded" | "unmeasured";

const STATES: readonly string[] = ["healthy", "degraded", "unmeasured"];

export interface HealthCounts {
  readonly total: number;
  readonly ready: number;
}

export interface EstateHealth {
  readonly state: HealthState;
  readonly stale: boolean;
  readonly checkedAt: string | null;
  readonly reason: string | null;
  readonly workloads: HealthCounts;
  readonly databases: HealthCounts;
}

/**
 * The unmeasured value, used for every shape this parser cannot trust.
 *
 * Deliberately not exported as a mutable object: every caller getting the
 * same frozen value is fine, a caller mutating a shared default is not.
 */
const UNMEASURED: EstateHealth = Object.freeze({
  state: "unmeasured" as const,
  stale: false,
  checkedAt: null,
  reason: null,
  workloads: Object.freeze({ total: 0, ready: 0 }),
  databases: Object.freeze({ total: 0, ready: 0 }),
});

function counts(value: unknown): HealthCounts {
  if (typeof value !== "object" || value === null) return { total: 0, ready: 0 };
  const record = value as Record<string, unknown>;
  return {
    total: typeof record.total === "number" ? record.total : 0,
    ready: typeof record.ready === "number" ? record.ready : 0,
  };
}

/**
 * Parse the wire shape.
 *
 * # Why this never throws and never defaults to healthy
 *
 * It renders in the layout, on every page. A parser that throws takes the
 * console down; a parser that defaults to "healthy" renders a green light for
 * an answer it did not understand — the same lie the third state exists to
 * prevent, reintroduced one layer further out. Anything unrecognised is
 * unmeasured.
 */
export function parseHealth(json: unknown): EstateHealth {
  if (typeof json !== "object" || json === null) return UNMEASURED;
  const record = json as Record<string, unknown>;

  const state =
    typeof record.state === "string" && STATES.includes(record.state)
      ? (record.state as HealthState)
      : "unmeasured";

  return {
    state,
    stale: record.stale === true,
    checkedAt: typeof record.checked_at === "string" ? record.checked_at : null,
    reason: typeof record.reason === "string" ? record.reason : null,
    workloads: counts(record.workloads),
    databases: counts(record.databases),
  };
}

/**
 * Read estate health from the platform API.
 *
 * Falls back to `unmeasured` on every failure rather than surfacing an error,
 * for the same reason the tools directory falls back: this renders in the
 * layout, and an operator who cannot load ANY console page because the health
 * endpoint is down is far worse off than one shown an honest "unmeasured".
 *
 * `PLATFORM_API_ORIGIN` unset is also unmeasured, and correctly so — nothing
 * measured it, which is exactly what the state says.
 */
export async function readEstateHealth(): Promise<EstateHealth> {
  if (platformApiOrigin() === null) return UNMEASURED;
  try {
    const { data } = await platformRequestWithMeta("estate health", "/v1/platform/health");
    return parseHealth(data);
  } catch {
    return UNMEASURED;
  }
}
