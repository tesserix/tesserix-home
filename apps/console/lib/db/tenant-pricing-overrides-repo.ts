// `server-only` for the same reason `promo-codes-repo.ts` carries it: this
// module reaches `pg` through `./tesserix`, and a client component that reaches
// it must fail the build with the import chain named rather than
// `Can't resolve 'net'` from somewhere inside the driver.
import "server-only";

import type { StripeMode } from "@/lib/billing/stripe-read";
import { tesserixQuery } from "./tesserix";

/**
 * Reads and writes for `tenant_pricing_override_coupons` (0047) — the console's
 * record of the Stripe Coupons it minted for individual tenants
 * (tesserix-home#331).
 *
 * ══ THIS TABLE RECORDS A MINT, NOT A DISCOUNT ══
 *
 * A row here says: this console created `co_…` in this Stripe account, for this
 * tenant, on this date. It does NOT say the tenant is being charged less. The
 * coupon is attached to the customer by mark8ly (#660), which audits the grant
 * inside the transaction that applies it — see 0047's header for why the
 * decision record lives there and not here.
 *
 * The gap is real and is the point: a coupon minted here and not yet attached
 * leaves a row that claims more than is true. #331 calls that state "minted,
 * not applied" and requires it be reported rather than hidden, which is only
 * possible because the mint is recorded.
 *
 * ══ THE AT-MOST-ONE RULE IS THE CHEAP HALF ══
 *
 * {@link readLiveTenantOverrideCoupon} plus 0047's partial unique index stop
 * this console minting a SECOND real coupon for a tenant it has already minted
 * one for. Whether the tenant actually holds a discount is mark8ly's to answer,
 * because only mark8ly can see the customer's discounts. Nothing in this module
 * should be read as the authority on that.
 */

/** One recorded mint. */
export interface TenantOverrideCoupon {
  id: string;
  /** The NAMESPACED tenant id, `<source>:<product id>` — see 0047. */
  tenantId: string;
  mode: StripeMode;
  /** A Stripe Coupon id (`co_...`), as returned by the create call. */
  stripeCouponId: string;
  grantedBy: string;
  grantedAt: string;
  /** Null while the override is live. Set by #331's T4, never by the grant
   *  path. */
  removedBy: string | null;
  removedAt: string | null;
}

interface TenantOverrideCouponDbRow {
  id: string;
  tenant_id: string;
  mode: StripeMode;
  stripe_coupon_id: string;
  granted_by: string;
  granted_at: unknown;
  removed_by: string | null;
  removed_at: unknown;
}

const COLUMNS = `id, tenant_id, mode, stripe_coupon_id, granted_by, granted_at, removed_by, removed_at`;

/** Local rather than shared, per `promo-codes-repo.ts`'s copy of the same
 *  function: `granted_at` is genuinely NOT NULL, so a null here means the query
 *  stopped selecting the column, which should be loud rather than silently
 *  rendered as an empty date. */
function toIsoRequired(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new Error(
    `tenant-pricing-overrides-repo: expected a timestamp, got ${String(value)}`,
  );
}

function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoRequired(value);
}

function toRow(row: TenantOverrideCouponDbRow): TenantOverrideCoupon {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    mode: row.mode,
    stripeCouponId: row.stripe_coupon_id,
    grantedBy: row.granted_by,
    grantedAt: toIsoRequired(row.granted_at),
    removedBy: row.removed_by,
    removedAt: toIsoOrNull(row.removed_at),
  };
}

/**
 * The tenant's live override coupon in one Stripe account, or null.
 *
 * LIVE ONLY — `removed_at IS NULL`, matching 0047's partial unique index
 * exactly, so this read and that index cannot disagree about which rows count.
 * A tenant whose override was retired reads as null here and can be granted a
 * new one, which is the whole reason the table carries a retirement marker
 * rather than a bare `(tenant_id, mode)` primary key.
 *
 * Returns at most one row by construction; `LIMIT 1` is not what makes it one.
 */
export async function readLiveTenantOverrideCoupon(
  tenantId: string,
  mode: StripeMode,
): Promise<TenantOverrideCoupon | null> {
  const rows = await tesserixQuery<TenantOverrideCouponDbRow>(
    `SELECT ${COLUMNS}
       FROM tenant_pricing_override_coupons
      WHERE tenant_id = $1 AND mode = $2 AND removed_at IS NULL`,
    [tenantId, mode],
  );
  return rows.length === 0 ? null : toRow(rows[0]);
}

export interface RecordTenantOverrideCouponInput {
  /** The NAMESPACED tenant id. */
  tenantId: string;
  mode: StripeMode;
  /** A Stripe Coupon id (`co_...`), as returned by the create call. */
  stripeCouponId: string;
  grantedBy: string;
}

/**
 * Record that this console minted a coupon for one tenant in one Stripe
 * account.
 *
 * A PLAIN INSERT, WITH NO `ON CONFLICT` — `recordStripeCoupon`'s rule, for the
 * same reason. A second live coupon for the same (tenant, mode) is refused by
 * 0047's partial unique index, loudly, and that is the intended behaviour
 * rather than an unhandled case: the first coupon is a real object in a real
 * Stripe account, and quietly overwriting the id that points at it ORPHANS it —
 * still live, still attachable, and no longer named by anything here.
 *
 * WHAT THIS FUNCTION CANNOT CHECK: it does not know whether the coupon is
 * attached to anything, and no constraint in 0047 can express it. The customer
 * lives in mark8ly. See this module's header.
 */
export async function recordTenantOverrideCoupon(
  input: RecordTenantOverrideCouponInput,
): Promise<TenantOverrideCoupon> {
  const rows = await tesserixQuery<TenantOverrideCouponDbRow>(
    `INSERT INTO tenant_pricing_override_coupons
       (tenant_id, mode, stripe_coupon_id, granted_by)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [input.tenantId, input.mode, input.stripeCouponId, input.grantedBy],
  );
  return toRow(rows[0]);
}
