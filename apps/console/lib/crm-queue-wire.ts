// `server-only` is deliberately NOT imported here: this module is pure data
// mapping with no database, no token and no `pg` import, and the queue views
// render its output. Keeping it browser-safe is what stops a future import
// from dragging the transport into the client bundle — the failure #299 fixed.

import type { QueuePage, QueueRow } from "@/lib/db/crm-repo";
import type { CrmStage } from "@/lib/crm";

/**
 * The platform API's queue row, exactly as `service/wire.go` renders it.
 *
 * Field for field the same as the raw pg row `crm-repo.ts` maps, because the
 * Go module was built to mirror it. That is why this parser is a rename rather
 * than a translation — and why a drift in either direction should fail loudly
 * here instead of arriving as `undefined` three components later.
 */
interface WireOpportunity {
  id: string;
  organisation_id: string;
  organisation_name: string;
  product: string | null;
  stage: CrmStage;
  owner: string | null;
  next_action_at: string | null;
  next_action_note: string | null;
  last_contacted_at: string | null;
  quiet_since: string;
  is_starred: boolean;
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string") {
    throw new Error(`crm queue: ${field} is not a string`);
  }
  return value;
}

function nullableString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`crm queue: ${field} is not a string or null`);
  }
  return value;
}

function toQueueRow(raw: unknown): QueueRow {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("crm queue: an opportunity was not an object");
  }
  const row = raw as Record<string, unknown>;
  return {
    id: requireString(row, "id"),
    organisationId: requireString(row, "organisation_id"),
    organisationName: requireString(row, "organisation_name"),
    product: nullableString(row, "product"),
    stage: requireString(row, "stage") as CrmStage,
    owner: nullableString(row, "owner"),
    nextActionAt: nullableString(row, "next_action_at"),
    nextActionNote: nullableString(row, "next_action_note"),
    lastContactedAt: nullableString(row, "last_contacted_at"),
    // Never recomputed from last_contacted_at/created_at here: it is the SQL
    // COALESCE the queue was ordered and filtered by, and a second copy of that
    // expression in TypeScript is exactly the drift the repo's comment warns of.
    quietSince: requireString(row, "quiet_since"),
    isStarred: row.is_starred === true,
  } satisfies QueueRow as QueueRow;
}

function readNumber(meta: Record<string, unknown>, field: string): number {
  const value = meta[field];
  return typeof value === "number" ? value : 0;
}

function readCursor(meta: Record<string, unknown>, field: string): string | null {
  const value = meta[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Turn one `/v1/crm/queues/*` response into the `QueuePage` the console's
 * existing views already take.
 *
 * `meta` is separate because the envelope splits them: `data` carries the rows,
 * `meta` carries the counts and cursors. A missing `meta` is not an error — an
 * empty queue legitimately has no cursors — but a missing count reads as 0
 * rather than NaN.
 */
export function parseQueuePage(data: unknown, meta: unknown): QueuePage {
  if (typeof data !== "object" || data === null) {
    throw new Error("crm queue: response data was not an object");
  }
  const payload = data as Record<string, unknown>;
  if (!Array.isArray(payload.opportunities)) {
    throw new Error("crm queue: opportunities was not an array");
  }
  const metaRecord =
    typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  return {
    rows: payload.opportunities.map(toQueueRow),
    total: readNumber(metaRecord, "total"),
    precedingCount: readNumber(metaRecord, "preceding_count"),
    nextCursor: readCursor(metaRecord, "next_cursor"),
    previousCursor: readCursor(metaRecord, "previous_cursor"),
  };
}
