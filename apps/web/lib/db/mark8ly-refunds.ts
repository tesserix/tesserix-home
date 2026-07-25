// lib/db/mark8ly-refunds.ts — mark8ly's refund side of the cross-product finance
// view, read from the marketplace_api `returns` table.
//
// mark8ly models a refund as a RETURN: the customer raises one against an order
// and it walks requested → approved → received → refunded (or → rejected).
// `type` separates a refund-only return from a replacement, which never pays
// money back — so a finance view must exclude replacements or it will overstate
// what was refunded.
//
// READ ONLY. Every mutation (approve / reject / received / refunded) must go
// through marketplace-api's own admin endpoints
// (/admin/stores/:storeId/returns/:id/*), which enforce the status lifecycle and
// the ReturnsViewRole RBAC. Writing to this table directly would bypass both.

import { mark8lyQuery } from "@/lib/db/mark8ly";

export interface Mark8lyRefundRow {
  readonly id: string;
  readonly returnNumber: string;
  readonly orderId: string;
  readonly storeId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly rejectReason: string | null;
  /** Minor units (paise/cents) so the finance contract stays integer-only. */
  readonly refundAmountMinor: number | null;
  readonly currencyCode: string;
  readonly requestedAt: string;
  readonly refundedAt: string | null;
}

export interface Mark8lyRefundFilter {
  /** Restrict to a status (requested | approved | received | refunded | rejected). */
  readonly status?: string;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(n: number | undefined): number {
  if (!n || Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

/**
 * Refund-bearing returns, newest request first.
 *
 * refund_amount is numeric(12,2) — a major-unit decimal. It comes back from pg
 * as a STRING to avoid float rounding, so convert to integer minor units here
 * rather than letting a float reach the UI: money must never round-trip through
 * a JS number.
 */
export async function listMark8lyRefunds(
  filter: Mark8lyRefundFilter = {},
): Promise<Mark8lyRefundRow[]> {
  const params: unknown[] = [];
  const where: string[] = [
    // Replacements never refund money — excluding them here keeps the finance
    // totals honest.
    `type = 'return'`,
  ];

  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }

  params.push(clampLimit(filter.limit));
  const sql = `
    SELECT
      id::text                                   AS id,
      return_number                              AS return_number,
      order_id::text                             AS order_id,
      store_id::text                             AS store_id,
      tenant_id::text                            AS tenant_id,
      status,
      reason,
      reject_reason,
      refund_amount::text                        AS refund_amount,
      currency_code,
      requested_at,
      refunded_at
    FROM returns
    WHERE ${where.join(" AND ")}
    ORDER BY requested_at DESC
    LIMIT $${params.length}
  `;

  const res = await mark8lyQuery<{
    id: string;
    return_number: string;
    order_id: string;
    store_id: string;
    tenant_id: string;
    status: string;
    reason: string | null;
    reject_reason: string | null;
    refund_amount: string | null;
    currency_code: string;
    requested_at: Date;
    refunded_at: Date | null;
  }>("marketplace_api", sql, params);

  return res.rows.map((r) => ({
    id: r.id,
    returnNumber: r.return_number,
    orderId: r.order_id,
    storeId: r.store_id,
    tenantId: r.tenant_id,
    status: r.status,
    reason: r.reason,
    rejectReason: r.reject_reason,
    refundAmountMinor: toMinorUnits(r.refund_amount),
    currencyCode: r.currency_code,
    requestedAt: r.requested_at.toISOString(),
    refundedAt: r.refunded_at ? r.refunded_at.toISOString() : null,
  }));
}

/**
 * Convert a numeric(12,2) decimal STRING to integer minor units.
 *
 * Deliberately string-based: Number("12.30") * 100 is 1229.9999999999998, and a
 * naive Math.round would still be wrong for values pg returns with trailing
 * precision. Parsing the digits avoids binary-float error entirely.
 */
export function toMinorUnits(decimal: string | null): number | null {
  if (decimal === null || decimal.trim() === "") return null;
  const m = /^(-)?(\d+)(?:\.(\d*))?$/.exec(decimal.trim());
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  const cents = (frac + "00").slice(0, 2);
  const value = Number(whole) * 100 + Number(cents);
  return sign === "-" ? -value : value;
}
