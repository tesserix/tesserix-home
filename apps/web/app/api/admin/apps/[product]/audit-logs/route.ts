// GET /api/admin/apps/:product/audit-logs
//
// The genuinely product-generic audit read. `:product` is one of mark8ly |
// kora | homechef, or `all` to fan out across every source at once.
//
// It did not used to be generic. It read mark8ly's audit_logs unconditionally,
// so serving it for another product returned MARK8LY's rows under that
// product's URL and every product overview showed mark8ly's critical-event
// count. That bug is the reason for two things below that look like overkill:
// the hard 404 on an unknown product (silently returning nothing is how the
// same class of bug ships next time), and the fact that dispatch is a table
// keyed by product rather than a chain of ifs.
//
// Every source normalises onto ONE wire shape — `@tesserix/web`'s
// `AuditLogEntry`, which is also exactly what `console_audit_log` stores —
// plus a `source` naming which product produced the row, at this boundary,
// once. See lib/audit/entry.ts.
//
// `source` is the third thing that looks like overkill and is not. Merging
// three products into one `entries[]` with nothing recording where each row
// came from means the console cannot show a Source column, and an audit log
// that says "who did what" without "where" is not a whole answer. It also
// makes `id` unique across the merge by construction, which matters because
// the renderer keys its list by `id` and a collision there is a mis-reconciled
// audit row.
//
// Response:
//   200 { product, entries, failures, summary, sinceHours, generatedAt }
//   404 { error: "unsupported_product" }        product has no audit source
//   501 { error: "not_configured", failures }   every source is unwired
//   502 { error: "audit_unavailable", failures } every source failed
//
// 501, not 503, for an unwired upstream: it is the console's NOT_IMPLEMENTED
// contract (apps/console/components/kit/surface-state.ts), which renders as
// "not measured" rather than as a red error. See #198.

import { NextResponse, type NextRequest } from "next/server";

import { byNewestFirst, type SourcedAuditLogEntry } from "@/lib/audit/entry";
import {
  ALL_PRODUCTS,
  AUDIT_PRODUCTS,
  fetchAuditSource,
  isAuditProduct,
  isNotConfigured,
  type AuditProduct,
  type AuditQuery,
  type Mark8lyLegacyBody,
  type Mark8lySeverity,
} from "@/lib/audit/sources";
import { logger } from "@/lib/logger";

/**
 * Matches /admin/search's `failures: {source, message}[]` exactly.
 *
 * `source` is an `AuditProduct`, the SAME vocabulary every entry's own `source`
 * uses — a reader can join the two without a mapping table, and "Kora could not
 * be read" lines up with the rows that would have said `kora`.
 */
interface SourceFailure {
  readonly source: AuditProduct;
  readonly message: string;
}

/**
 * The whole response, plus an optional second, mark8ly-shaped half of it.
 *
 * `rows` and `filterOptions` are what `/admin/apps/mark8ly/audit-logs` renders
 * from. #139 retired that page and dropped both; the page is restored and so
 * are they — the two systems run side by side and read the SAME endpoint,
 * neither one reshaping it for the other. The console reads `entries`; the
 * admin page reads `rows`.
 *
 * They are present only when the caller passes `?include=rows` against a
 * mark8ly-scoped URL. That opt-in is not decoration: `filterOptions` costs two
 * DISTINCT scans over audit_logs on a db-f1-micro, and the two callers that do
 * not want it — the console's `all` fan-out and the product overviews'
 * critical-events tile — outnumber the one that does.
 */
interface AuditResponseBody {
  readonly product: string;
  /**
   * Every entry carries the source that produced it and an id namespaced with
   * it. Both are set at the normaliser (see lib/audit/entry.ts's `attributeTo`)
   * because this is where three products become one list, and after the merge
   * neither fact is recoverable.
   */
  readonly entries: readonly SourcedAuditLogEntry[];
  readonly failures: readonly SourceFailure[];
  /**
   * `criticalLast24h` is null for any product whose audit has no severity
   * concept. Null, not 0 — "we do not measure this" and "we measured zero" are
   * different claims and only one of them is true for kora and homechef.
   */
  readonly summary: { readonly criticalLast24h: number | null };
  readonly sinceHours: number;
  readonly generatedAt: string;
  readonly rows?: Mark8lyLegacyBody["rows"];
  readonly filterOptions?: Mark8lyLegacyBody["filterOptions"];
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_SINCE_HOURS = 24;
const MAX_SINCE_HOURS = 720;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseQuery(url: URL, product: string): AuditQuery {
  const p = url.searchParams;
  return {
    // mark8ly-scoped only: `all` merges three products and there is no single
    // product's raw rows to hand back.
    includeLegacyMark8ly: product === "mark8ly" && p.get("include") === "rows",
    severity: p.get("severity") ?? undefined,
    status: p.get("status") ?? undefined,
    action: p.get("action") ?? undefined,
    resourceType: p.get("resource_type") ?? undefined,
    actorEmail: p.get("actor_email") ?? undefined,
    tenantId: p.get("tenant_id") ?? undefined,
    sinceHours: clampInt(p.get("since_hours"), DEFAULT_SINCE_HOURS, 1, MAX_SINCE_HOURS),
    limit: clampInt(p.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT),
  };
}

/**
 * Which sources a request targets. `null` means the product is unknown, which
 * is a 404 — NOT an empty list. A product that has audit and is answered with
 * `[]` looks healthy while hiding its entire integrity record.
 */
function resolveTargets(product: string): readonly AuditProduct[] | null {
  if (product === ALL_PRODUCTS) return AUDIT_PRODUCTS;
  return isAuditProduct(product) ? [product] : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  const targets = resolveTargets(product);
  if (!targets) {
    return NextResponse.json({ error: "unsupported_product" }, { status: 404 });
  }

  const query = parseQuery(new URL(req.url), product);

  // allSettled, not all: one product's upstream being down must not erase the
  // others' rows. Same reasoning (and same response shape) as /admin/search.
  const settled = await Promise.allSettled(
    targets.map((p) => fetchAuditSource(p, query)),
  );

  const entries: SourcedAuditLogEntry[] = [];
  const failures: SourceFailure[] = [];
  let everyFailureIsUnconfigured = true;
  let succeeded = 0;
  let severity: Mark8lySeverity | undefined;
  let legacy: Mark8lyLegacyBody | undefined;

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const source = targets[i];
    if (outcome.status === "fulfilled") {
      succeeded++;
      entries.push(...outcome.value.entries);
      if (outcome.value.severity) severity = outcome.value.severity;
      if (outcome.value.legacy) legacy = outcome.value.legacy;
      continue;
    }
    const reason: unknown = outcome.reason;
    if (!isNotConfigured(reason)) everyFailureIsUnconfigured = false;
    logger.warn(`[audit-logs] source ${source} failed`, reason);
    failures.push({
      source,
      message: reason instanceof Error ? reason.message : "unknown error",
    });
  }

  // Zero successful sources is NOT partial data — there is nothing to be
  // partial about, and answering 200 with `entries: []` would render as "no
  // audit events" when the truth is "we could not read the audit log". The
  // status is the only thing that distinguishes those two, so it has to carry
  // the difference.
  if (succeeded === 0 && failures.length > 0) {
    const status = everyFailureIsUnconfigured ? 501 : 502;
    return NextResponse.json(
      { error: everyFailureIsUnconfigured ? "not_configured" : "audit_unavailable", failures },
      { status },
    );
  }

  entries.sort(byNewestFirst);

  const body: AuditResponseBody = {
    product,
    entries: entries.slice(0, query.limit),
    failures,
    summary: { criticalLast24h: severity ? severity.criticalLast24h : null },
    sinceHours: query.sinceHours,
    generatedAt: new Date().toISOString(),
    // Spread, not two `?? undefined` fields: an unrequested legacy body must
    // leave the keys absent rather than serialise as `"rows": null`, which a
    // caller cannot tell from "mark8ly has no rows".
    ...(legacy ? { rows: legacy.rows, filterOptions: legacy.filterOptions } : {}),
  };
  return NextResponse.json(body);
}
