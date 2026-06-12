// Customer-ops: read-only views over Home Chef orders, direct from homechef_db
// as homechef_platform_admin. Powers the tesserix-home Orders admin page
// (orders list + GMV summary). 5B customer-ops oversight.
//
// Schema: orders(order_number, customer_id, chef_id, status, total,
// delivery_fee, currency, created_at), users(first_name,last_name,email),
// chef_profiles(business_name).

import { homechefQuery } from "@/lib/db/homechef";

export interface OrderRow {
  id: string;
  order_number: string;
  customer_name: string | null;
  chef_name: string | null;
  status: string;
  total: number;
  delivery_fee: number;
  currency: string;
  created_at: string;
}

export interface OrderFilter {
  status?: string;
  limit?: number;
  offset?: number;
}

export interface OrdersSummary {
  total_orders: number; // matching the filter
  gmv: number;          // sum(total) excl. cancelled/refunded, matching the filter
}

const toNum = (v: string | number | null | undefined): number =>
  v == null ? 0 : Number(v);

function buildWhere(filter: OrderFilter): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`o.status = $${params.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export async function listOrders(filter: OrderFilter): Promise<OrderRow[]> {
  const { where, params } = buildWhere(filter);
  const limit = filter.limit && filter.limit > 0 ? filter.limit : 25;
  const offset = filter.offset && filter.offset > 0 ? filter.offset : 0;
  const sql = `
    SELECT o.id, o.order_number,
           NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS customer_name,
           cp.business_name AS chef_name,
           o.status, o.total, o.delivery_fee, o.currency, o.created_at
      FROM orders o
      LEFT JOIN users u ON u.id = o.customer_id
      LEFT JOIN chef_profiles cp ON cp.id = o.chef_id
      ${where}
     ORDER BY o.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`;
  const res = await homechefQuery<Record<string, unknown>>(sql, params);
  return res.rows.map((r) => ({
    id: String(r.id),
    order_number: String(r.order_number),
    customer_name: (r.customer_name as string) ?? null,
    chef_name: (r.chef_name as string) ?? null,
    status: (r.status as string) ?? "pending",
    total: toNum(r.total as string),
    delivery_fee: toNum(r.delivery_fee as string),
    currency: (r.currency as string) ?? "INR",
    created_at: String(r.created_at),
  }));
}

export async function countOrders(filter: OrderFilter): Promise<number> {
  const { where, params } = buildWhere(filter);
  const res = await homechefQuery<{ count: string }>(
    `SELECT count(*)::bigint AS count FROM orders o ${where}`,
    params,
  );
  return toNum(res.rows[0]?.count);
}

export async function getOrdersSummary(filter: OrderFilter): Promise<OrdersSummary> {
  const { where, params } = buildWhere(filter);
  const gmvWhere = where
    ? `${where} AND o.status NOT IN ('cancelled','refunded')`
    : `WHERE o.status NOT IN ('cancelled','refunded')`;
  const [count, gmv] = await Promise.all([
    homechefQuery<{ count: string }>(`SELECT count(*)::bigint AS count FROM orders o ${where}`, params),
    homechefQuery<{ gmv: string }>(`SELECT COALESCE(sum(total),0)::numeric AS gmv FROM orders o ${gmvWhere}`, params),
  ]);
  return { total_orders: toNum(count.rows[0]?.count), gmv: toNum(gmv.rows[0]?.gmv) };
}
