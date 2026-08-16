// Per-product audit sources, each normalised onto the one `AuditLogEntry` wire
// shape (see entry.ts).
//
// These three are NOT three copies of one thing. They are three different
// architectures, and the point of this module is that the difference stops
// here rather than leaking into every consumer:
//
//   mark8ly  -> direct SQL into mark8ly's own DB (a cross-DB grant, see #160)
//   kora     -> HMAC-signed call to kora-api's /v1/admin/events
//   homechef -> HMAC-signed call to homechef-api's /api/v1/admin/audit-logs
//
// Nothing here fabricates a value. Where a product's audit genuinely cannot
// express one of the six fields, the field is left `undefined` (it is optional)
// or the upstream's own documented meaning is carried across verbatim. An
// invented actor in an audit log is worse than a missing one.

import {
  getCriticalEventCount,
  listAuditLogs,
  type AuditLogRow,
} from "@/lib/db/mark8ly-audit";
import { mark8lyQuery } from "@/lib/db/mark8ly";
import { listKoraEvents, type KoraAdminEvent } from "@/lib/api/kora-admin";
import { homechefAdmin } from "@/lib/api/homechef-admin";
// Aliased deliberately: homechef-shared exports its OWN `AuditLogEntry`, a
// different shape from the wire type. See entry.ts's header.
import type { AuditLogEntry as HomechefAuditRow } from "@tesserix/homechef-shared";

import {
  AUDIT_PRODUCTS,
  attributeTo,
  isAuditProduct,
  joinTarget,
  stringifyMetadata,
  toIsoTimestamp,
  type AuditProduct,
  type SourcedAuditLogEntry,
} from "./entry";

// The source vocabulary now lives with the wire shape (`source` is a field on
// it). Re-exported so this module still reads as the one place that knows which
// products have an audit trail.
export { AUDIT_PRODUCTS, isAuditProduct, type AuditProduct };

/**
 * The pseudo-product that fans out across every source at once. This is what
 * makes "one product failing must not fail the others" expressible in a single
 * response: a per-product URL has exactly one source and nothing to be partial
 * about. It is a KNOWN product id, so the 404 gate below still rejects
 * genuinely unknown ones.
 */
export const ALL_PRODUCTS = "all";

/** Filters a caller may pass. Each source applies only what its upstream supports. */
export interface AuditQuery {
  readonly severity?: string;
  readonly status?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly actorEmail?: string;
  readonly tenantId?: string;
  readonly sinceHours: number;
  readonly limit: number;
}

/**
 * mark8ly's severity summary — the one thing `entries` cannot express.
 *
 * This was `Mark8lyLegacyBody` and carried `rows` and `filterOptions` too, so
 * `/admin/apps/mark8ly/audit-logs` could keep rendering while the generic
 * endpoint was built underneath it. That page is retired (#139), and both
 * fields went with it.
 *
 * `criticalLast24h` did NOT go with it, and the distinction is worth stating
 * because it looks like leftover debt and is not. It feeds the critical-events
 * KPI tile on every product overview (`product-overview-layout.tsx`), a surface
 * that is not being retired. It is also genuinely absent from `entries`: an
 * aggregate over a 24-hour window is not derivable from a capped, merged list —
 * counting the `severity: critical` rows on screen would answer "critical
 * events among the most recent 200" while looking like "critical events today".
 *
 * mark8ly-only, because severity is mark8ly-only. kora and homechef have no
 * such concept and the route reports null for them rather than zero.
 */
export interface Mark8lySeverity {
  readonly criticalLast24h: number;
}

export interface AuditSourceResult {
  readonly entries: readonly SourcedAuditLogEntry[];
  readonly severity?: Mark8lySeverity;
}

// Each normaliser below attributes its own rows via `attributeTo`, naming its
// source as a literal. That is deliberate: the source is set BY THE THING THAT
// PRODUCED THE ROW, not applied afterwards by whoever happens to be merging.
// A route-level `attributeTo(targets[i], ...)` would read the same today and
// would be one refactor away from labelling a row with the wrong product —
// `route.test.ts` asserts each product's rows carry that product, per source.

// ---------------------------------------------------------------------------
// mark8ly
// ---------------------------------------------------------------------------

/**
 * mark8ly's `audit_logs`, read straight out of its database.
 *
 * DEBT (#160): this is the one source that is not an API call. It depends on a
 * cross-DB grant from tesserix-home into mark8ly's `marketplace_api`/
 * `platform_api` schemas, which is the exact coupling #160 exists to remove.
 * Replacing it with a mark8ly-owned endpoint is that issue's job, not this
 * one's — but the debt is named here so it is visible from the place that
 * depends on it, not only from the issue tracker.
 */
async function fetchMark8ly(q: AuditQuery): Promise<AuditSourceResult> {
  // `getAuditFilterOptions` used to be a third query here, feeding the retired
  // page's action/resource-type dropdowns. Dropped with the page (#139): it was
  // two DISTINCT scans over audit_logs that nothing reads any more, against a
  // db-f1-micro, on every request.
  const [rows, criticalLast24h] = await Promise.all([
    listAuditLogs({
      severity: q.severity,
      status: q.status,
      action: q.action,
      resourceType: q.resourceType,
      actorEmail: q.actorEmail,
      tenantId: q.tenantId,
      sinceHours: q.sinceHours,
      limit: q.limit,
    }),
    getCriticalEventCount(24),
  ]);

  // Tenant names are a second query against a different mark8ly database, so
  // it only runs when there is something to resolve.
  const tenantIds = Array.from(new Set(rows.map((r) => r.tenant_id)));
  const namesById = new Map<string, string>();
  if (tenantIds.length > 0) {
    const namesRes = await mark8lyQuery<{ id: string; name: string }>(
      "platform_api",
      `SELECT id::text, name FROM tenants WHERE id = ANY($1::uuid[])`,
      [tenantIds],
    );
    for (const r of namesRes.rows) namesById.set(r.id, r.name);
  }

  const withNames = rows.map((r) => ({
    ...r,
    tenantName: namesById.get(r.tenant_id) ?? r.tenant_id,
  }));

  return {
    entries: withNames.map(normaliseMark8ly),
    severity: { criticalLast24h },
  };
}

/**
 * `actor` falls back through email -> user id -> `actor_type`. That last step
 * is not a placeholder: `actor_type` is NOT NULL and carries mark8ly's own
 * word for a non-human actor ("system", "service"), so a row with no email and
 * no user id still names truthfully who acted.
 */
export function normaliseMark8ly(
  row: AuditLogRow & { tenantName: string },
): SourcedAuditLogEntry {
  return attributeTo("mark8ly", {
    id: row.id,
    actor: row.actor_email ?? row.actor_user_id ?? row.actor_type,
    action: row.action,
    target: joinTarget(row.resource_type, row.resource_id),
    timestamp: toIsoTimestamp(row.created_at),
    metadata: stringifyMetadata({
      severity: row.severity,
      status: row.status,
      tenant: row.tenantName,
      ip: row.ip_address,
      ...row.metadata,
    }),
  });
}

// ---------------------------------------------------------------------------
// kora
// ---------------------------------------------------------------------------

/**
 * Kora's `kora_admin_events`, via the same signed client the server component
 * at /admin/apps/kora/audit already uses. This adds no new trust path — it
 * only puts an existing read behind HTTP so the console can reach it.
 *
 * kora-api's /v1/admin/events takes no severity/actor/time filters, so those
 * query params are silently unsupported here rather than applied after the
 * fact: post-filtering a page of 200 rows would report "3 events" when the
 * honest answer is "3 of the most recent 200".
 */
async function fetchKora(q: AuditQuery): Promise<AuditSourceResult> {
  const page = await listKoraEvents({ limit: q.limit });
  return { entries: page.items.map(normaliseKora) };
}

export function normaliseKora(event: KoraAdminEvent): SourcedAuditLogEntry {
  return attributeTo("kora", {
    id: event.id,
    // actor_email is written by kora from the signed BFF identity, so it is
    // present on every row; actor_id is the fallback, not a fabrication.
    actor: event.actor_email || event.actor_id,
    action: event.action,
    target: joinTarget(event.target_type, event.target_id),
    timestamp: toIsoTimestamp(event.created_at),
    metadata: stringifyMetadata({ before: event.before, after: event.after }),
  });
}

// ---------------------------------------------------------------------------
// homechef / fe3dr
// ---------------------------------------------------------------------------

/** homechef-api's audit endpoint answers a flat body, NOT the Paginated<T> envelope. */
interface HomechefAuditBody {
  logs?: HomechefAuditRow[] | null;
  total?: number;
}

/**
 * HomeChef's audit trail through the same signed client that
 * /api/admin/apps/homechef/gw/[...path] proxies to.
 *
 * Calling `homechefAdmin` directly rather than fetching our own gateway route
 * over HTTP: the gateway is a browser-facing convenience (it exists so client
 * pages get same-origin, cookie-authed access). Server-side we are already
 * inside the process that holds the HMAC key, so going out to localhost and
 * back would add a hop, require forwarding the session cookie to ourselves,
 * and fail in exactly the environments — build, test — where there is no
 * listening server. Same signer, same signed path, one less round trip.
 */
async function fetchHomechef(q: AuditQuery): Promise<AuditSourceResult> {
  const search: Record<string, string> = { limit: String(q.limit), page: "1" };
  if (q.action) search.action = q.action;

  const { status, data } = await homechefAdmin<HomechefAuditBody>(
    "GET",
    "/audit-logs",
    { search },
  );
  if (status !== 200) {
    // Carried, not swallowed: an audit surface that renders a 403 as an empty
    // table is asserting "nobody has changed anything", which is a false
    // statement about the integrity record itself.
    throw Object.assign(new Error(`homechef audit responded ${status}`), { status });
  }
  // A Go nil slice serialises as JSON `null`, so `logs` is genuinely absent on
  // a quiet day — see the gateway route's comment about `data ?? {}`.
  return { entries: (data?.logs ?? []).map(normaliseHomechef) };
}

/**
 * `userId: null` is homechef's DOCUMENTED encoding for "no acting human — a
 * cron or an internal service made this change" (see homechef-shared's
 * contracts.ts). Rendering that as "system" carries the upstream's own meaning
 * across; it is not an invented actor, and it is what the page being retired
 * already displayed.
 */
export function normaliseHomechef(row: HomechefAuditRow): SourcedAuditLogEntry {
  return attributeTo("homechef", {
    id: row.id,
    actor: homechefActor(row),
    action: row.action,
    target: joinTarget(row.entityType, row.entityId),
    timestamp: toIsoTimestamp(row.createdAt),
    metadata: stringifyMetadata({
      before: row.oldValue,
      after: row.newValue,
      ip: row.ipAddress,
    }),
  });
}

function homechefActor(row: HomechefAuditRow): string {
  const name = [row.user?.firstName, row.user?.lastName].filter(Boolean).join(" ").trim();
  return name || row.user?.email || row.userId || "system";
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const FETCHERS: Readonly<Record<AuditProduct, (q: AuditQuery) => Promise<AuditSourceResult>>> = {
  mark8ly: fetchMark8ly,
  kora: fetchKora,
  homechef: fetchHomechef,
};

export function fetchAuditSource(
  product: AuditProduct,
  query: AuditQuery,
): Promise<AuditSourceResult> {
  return FETCHERS[product](query);
}

/**
 * True when a source failed because its upstream is not wired up at all, as
 * opposed to being wired up and broken. The distinction is the whole of the
 * console's `NOT_IMPLEMENTED` (501) contract: 501 renders as "not measured",
 * anything else renders as a red error, and a parked data plane shown in red
 * trains operators to ignore red.
 *
 * Both signed clients raise a `not_configured` code. mark8ly's connection pool
 * raises a BARE `Error` with no code (lib/db/mark8ly.ts throws on missing
 * MARK8LY_DB_* env), so its message is matched as well — string matching is
 * unpleasant, but the alternative is answering 502 for an unconfigured
 * mark8ly and letting the console paint it as an outage.
 */
export function isNotConfigured(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { code?: unknown }).code === "not_configured") {
    return true;
  }
  return err instanceof Error && err.message.startsWith("mark8ly DB env not set");
}
