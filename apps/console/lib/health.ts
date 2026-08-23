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

  const checkedAt = typeof record.checked_at === "string" ? record.checked_at : null;
  const workloads = counts(record.workloads);
  const databases = counts(record.databases);

  // The Go classifier refuses to call an empty reading healthy. Re-derived
  // here rather than trusted, because a version skew, a partial payload or a
  // renamed field can all cross this wire, and the rule has to survive that.
  // Guarding the state STRING is not the same as guarding the CLAIM.
  if (state === "healthy" && (workloads.total === 0 || databases.total === 0)) {
    return {
      ...UNMEASURED,
      checkedAt,
      reason: "the reading claimed healthy but counted nothing",
    };
  }

  // The same distrust, applied to the counts the payload DID carry. A payload
  // can say "healthy" and report 3 of 8 workloads ready — version skew again,
  // or a partial answer — and rendering that green puts the word "Healthy"
  // directly above "Workloads 3 / 8". `degraded`, not `unmeasured`: something
  // WAS measured here and it came back short, which is a different claim from
  // "no instrument reported". Downgrading to unmeasured would discard a real
  // reading; the honest reading of short counts is that the estate is degraded.
  if (
    state === "healthy" &&
    (workloads.ready < workloads.total || databases.ready < databases.total)
  ) {
    return {
      state: "degraded",
      stale: record.stale === true,
      checkedAt,
      reason:
        "the reading claimed healthy but reported fewer ready than total: " +
        `${workloads.ready}/${workloads.total} workloads, ` +
        `${databases.ready}/${databases.total} databases`,
      workloads,
      databases,
    };
  }

  return {
    state,
    stale: record.stale === true,
    checkedAt,
    reason: typeof record.reason === "string" ? record.reason : null,
    workloads,
    databases,
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
    const { data } = await platformRequestWithMeta("estate health", "/v1/platform/health", {
      // Node's fetch has no request-level timeout and undici's headersTimeout
      // is 300s. This runs in the root layout inside a Promise.all, so an
      // unbounded await here is not a slow indicator — it is every console
      // page hanging on a decorative element. Three seconds is far above the
      // p99 of a cached in-cluster read and far below anything a person will
      // wait for.
      signal: AbortSignal.timeout(3000),
    });
    return parseHealth(data);
  } catch (cause) {
    // Logged, not swallowed. This is the only place that knows WHY the
    // indicator went unmeasured — the operator sees the same grey dot whether
    // the API is down, the origin is unset, or the RBAC grant was never
    // applied, and without this line the three are indistinguishable from
    // outside. It fires once per console page render for as long as the
    // platform API is unreachable — twice on `/platform/health`, which reads
    // health in the layout (the header indicator) and again in the page, each
    // through its own call. `platformCall` sets `cache: "no-store"`,
    // and the 15s cache is the Go service's own, bounding cluster reads rather
    // than this request. In the cases that reach this catch (unreachable, 5xx,
    // non-JSON, 403, or the abort above) the request never gets far enough for
    // any cache to help. That volume is accepted: the alternative is a silent
    // outage.
    console.warn("[console] estate health unavailable", cause);
    return UNMEASURED;
  }
}
