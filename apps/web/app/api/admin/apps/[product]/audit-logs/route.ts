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
// `AuditLogEntry`, which is also exactly what `console_audit_log` stores — at
// this boundary, once. See lib/audit/entry.ts.
//
// Response:
//   200 { product, entries, failures, summary, sinceHours, generatedAt, ... }
//   404 { error: "unsupported_product" }        product has no audit source
//   501 { error: "not_configured", failures }   every source is unwired
//   502 { error: "audit_unavailable", failures } every source failed
//
// 501, not 503, for an unwired upstream: it is the console's NOT_IMPLEMENTED
// contract (apps/console/components/kit/surface-state.ts), which renders as
// "not measured" rather than as a red error. See #198.

import { NextResponse, type NextRequest } from "next/server";

import { byNewestFirst, type AuditLogEntry } from "@/lib/audit/entry";
import {
  ALL_PRODUCTS,
  AUDIT_PRODUCTS,
  fetchAuditSource,
  isAuditProduct,
  isNotConfigured,
  type AuditProduct,
  type AuditQuery,
  type Mark8lyLegacyBody,
} from "@/lib/audit/sources";
import { logger } from "@/lib/logger";

/** Matches /admin/search's `failures: {source, message}[]` exactly. */
interface SourceFailure {
  readonly source: string;
  readonly message: string;
}

interface AuditResponseBody {
  readonly product: string;
  readonly entries: readonly AuditLogEntry[];
  readonly failures: readonly SourceFailure[];
  /**
   * `criticalLast24h` is null for any product whose audit has no severity
   * concept. Null, not 0 — "we do not measure this" and "we measured zero" are
   * different claims and only one of them is true for kora and homechef.
   */
  readonly summary: { readonly criticalLast24h: number | null };
  readonly sinceHours: number;
  readonly generatedAt: string;
  /** @deprecated mark8ly-only, retired with the page in Task 3. */
  readonly rows?: Mark8lyLegacyBody["rows"];
  /** @deprecated mark8ly-only, retired with the page in Task 3. */
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

function parseQuery(url: URL): AuditQuery {
  const p = url.searchParams;
  return {
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

  const query = parseQuery(new URL(req.url));

  // allSettled, not all: one product's upstream being down must not erase the
  // others' rows. Same reasoning (and same response shape) as /admin/search.
  const settled = await Promise.allSettled(
    targets.map((p) => fetchAuditSource(p, query)),
  );

  const entries: AuditLogEntry[] = [];
  const failures: SourceFailure[] = [];
  let everyFailureIsUnconfigured = true;
  let succeeded = 0;
  let legacy: Mark8lyLegacyBody | undefined;

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const source = targets[i];
    if (outcome.status === "fulfilled") {
      succeeded++;
      entries.push(...outcome.value.entries);
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
    summary: { criticalLast24h: legacy ? legacy.criticalLast24h : null },
    sinceHours: query.sinceHours,
    generatedAt: new Date().toISOString(),
    ...(legacy ? { rows: legacy.rows, filterOptions: legacy.filterOptions } : {}),
  };
  return NextResponse.json(body);
}
