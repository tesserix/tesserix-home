// GET /api/admin/dashboard — first end-to-end read across both DBs.
// Returns counts the platform-operator dashboard cares about:
//   - tenants total / active           (mark8ly platform_api)
//   - stores total                     (mark8ly marketplace_api)
//   - leads bucketed by status         (tesserix-postgres own)
//   - active products (apps registry)  (tesserix-postgres own)
//
// Auth: gated by `middleware.ts` which default-denies /api/* without a
// session cookie. No additional check needed here.

import { NextResponse } from "next/server";

import { mark8lyQuery } from "@/lib/db/mark8ly";
import { tesserixQuery } from "@/lib/db/tesserix";
import type { LeadStatus } from "@/lib/db/types";
import { logger } from "@/lib/logger";

// node-postgres returns BIGINT as string by default to avoid JS-number
// precision loss above 2^53. We're counting tenants/stores/leads — well
// under that — so coerce to Number at the boundary for ergonomic JSON.
const toNum = (v: string | number | null | undefined): number =>
  v == null ? 0 : Number(v);

interface TenantStatsRow {
  total: string;
  active: string;
}
interface CountRow {
  count: string;
}
interface LeadStatusCountRow {
  status: LeadStatus;
  count: string;
}

export async function GET() {
  try {
    const [tenantStats, storeCount, leadsByStatus, appsActive] =
      await Promise.all([
        mark8lyQuery<TenantStatsRow>(
          "platform_api",
          `SELECT
             count(*)::bigint AS total,
             count(*) FILTER (WHERE status='active')::bigint AS active
           FROM tenants`,
        ),
        mark8lyQuery<CountRow>(
          "marketplace_api",
          `SELECT count(*)::bigint AS count FROM stores`,
        ),
        tesserixQuery<LeadStatusCountRow>(
          `SELECT status, count(*)::bigint AS count
           FROM leads
           GROUP BY status
           ORDER BY status`,
        ),
        tesserixQuery<CountRow>(
          `SELECT count(*)::bigint AS count
           FROM apps WHERE status = 'active'`,
        ),
      ]);

    const leadStatusBuckets: Record<LeadStatus, number> = {
      new: 0,
      contacted: 0,
      qualified: 0,
      converted: 0,
      lost: 0,
    };
    for (const row of leadsByStatus.rows) {
      leadStatusBuckets[row.status] = toNum(row.count);
    }

    return NextResponse.json({
      tenants: {
        total: toNum(tenantStats.rows[0]?.total),
        active: toNum(tenantStats.rows[0]?.active),
      },
      stores: {
        total: toNum(storeCount.rows[0]?.count),
      },
      leads: {
        by_status: leadStatusBuckets,
        total: Object.values(leadStatusBuckets).reduce((a, b) => a + b, 0),
      },
      apps: {
        active: toNum(appsActive.rows[0]?.count),
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("[dashboard] query failed", err);
    return NextResponse.json(
      { error: "dashboard query failed" },
      { status: 500 },
    );
  }
}
