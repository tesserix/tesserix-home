// Home Chef business KPIs for the product overview, read live from homechef_db
// as homechef_platform_admin. Keys match the businessKpiTiles in
// lib/products/configs.ts. "Today" is the IST calendar day (the product settles
// on IST — see homechef statement_cron).
//
// Schema (Home-Chef-App GORM models):
//   chef_profiles(is_verified bool, is_active bool)
//   orders(total numeric, status varchar, created_at timestamptz)
//   approval_requests(status varchar)

import { homechefQuery } from "@/lib/db/homechef";
import { logger } from "@/lib/logger";

export interface HomechefKpis {
  chefs_active: number;
  orders_today: number;
  gmv_today: number;
  approvals_pending: number;
}

const toNum = (v: string | number | null | undefined): number =>
  v == null ? 0 : Number(v);

// IST day start as a timestamptz: midnight of the current Asia/Kolkata date.
const IST_DAY_START = "((now() AT TIME ZONE 'Asia/Kolkata')::date) AT TIME ZONE 'Asia/Kolkata'";

export async function getHomechefKpis(): Promise<HomechefKpis> {
  const [chefs, ordersToday, approvals] = await Promise.all([
    homechefQuery<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM chef_profiles
        WHERE is_verified = true AND is_active = true`,
    ),
    homechefQuery<{ orders: string; gmv: string }>(
      `SELECT count(*)::bigint AS orders,
              COALESCE(sum(total), 0)::numeric AS gmv
         FROM orders
        WHERE created_at >= ${IST_DAY_START}
          AND status NOT IN ('cancelled', 'refunded')`,
    ),
    homechefQuery<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM approval_requests
        WHERE status = 'pending'`,
    ),
  ]);

  return {
    chefs_active: toNum(chefs.rows[0]?.count),
    orders_today: toNum(ordersToday.rows[0]?.orders),
    gmv_today: toNum(ordersToday.rows[0]?.gmv),
    approvals_pending: toNum(approvals.rows[0]?.count),
  };
}

// Safe wrapper: a KPI source outage should degrade the tile to "—", not 500 the
// whole overview. Returns an empty object on failure (the layout shows "—").
export async function getHomechefKpisSafe(): Promise<Partial<HomechefKpis>> {
  try {
    return await getHomechefKpis();
  } catch (err) {
    logger.error("[homechef-kpis] query failed", err);
    return {};
  }
}
