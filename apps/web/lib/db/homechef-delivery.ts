// 3PL delivery admin (Wave 7E): provider oversight + cost reconciliation,
// direct from homechef_db as homechef_platform_admin.
//
// Reconciliation compares what Fe3dr PAYS the 3PL (deliveries.provider_cost)
// vs what it COLLECTS from customers (deliveries.delivery_fee). Provider API
// keys + the live "test connection" action are intentionally NOT here — those
// stay in homechef-api's /admin/delivery/providers CRUD (it owns the key
// handling + makes the outbound test call). This surface is read + enable/disable.
//
// Schema: delivery_providers(name, code, is_enabled, is_active, priority,
// base_cost, currency, total_deliveries, success_rate, last_used_at),
// deliveries(provider_id, provider_cost, delivery_fee, status, created_at).

import { homechefQuery, homechefTx } from "@/lib/db/homechef";

export interface ProviderRow {
  id: string;
  name: string;
  code: string;
  is_enabled: boolean;
  is_active: boolean;
  priority: number;
  base_cost: number;
  currency: string;
  total_deliveries: number;
  success_rate: number;
  last_used_at: string | null;
}

export interface DeliveryReconciliation {
  total_3pl_deliveries: number;
  provider_cost: number;   // what Fe3dr pays providers
  collected_fee: number;   // what Fe3dr collected from customers
  margin: number;          // collected - cost (negative = subsidy)
}

const toNum = (v: string | number | null | undefined): number =>
  v == null ? 0 : Number(v);

export async function listProviders(): Promise<ProviderRow[]> {
  const res = await homechefQuery<Record<string, unknown>>(
    `SELECT id, name, code, is_enabled, is_active, priority, base_cost, currency,
            total_deliveries, success_rate, last_used_at
       FROM delivery_providers
      WHERE deleted_at IS NULL
      ORDER BY priority ASC, name ASC`,
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    code: String(r.code),
    is_enabled: Boolean(r.is_enabled),
    is_active: Boolean(r.is_active),
    priority: toNum(r.priority as string),
    base_cost: toNum(r.base_cost as string),
    currency: (r.currency as string) ?? "INR",
    total_deliveries: toNum(r.total_deliveries as string),
    success_rate: toNum(r.success_rate as string),
    last_used_at: (r.last_used_at as string) ?? null,
  }));
}

export interface ToggleResult {
  id: string;
  is_enabled: boolean;
}

// Flip a provider's is_enabled in a txn + audit row.
export async function toggleProvider(id: string): Promise<ToggleResult | null> {
  return homechefTx(async (client) => {
    const upd = await client.query<{ is_enabled: boolean }>(
      `UPDATE delivery_providers
          SET is_enabled = NOT is_enabled, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING is_enabled`,
      [id],
    );
    if (upd.rowCount === 0) return null;
    const isEnabled = upd.rows[0]!.is_enabled;
    await client.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, new_value, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [
        "admin.delivery.provider.toggle",
        "delivery_provider",
        id,
        JSON.stringify({ isEnabled, actor: "homechef_platform_admin", source: "tesserix-home" }),
      ],
    );
    return { id, is_enabled: isEnabled };
  });
}

export async function getReconciliation(): Promise<DeliveryReconciliation> {
  const res = await homechefQuery<{ n: string; cost: string; fee: string }>(
    `SELECT count(*)::bigint AS n,
            COALESCE(sum(provider_cost),0)::numeric AS cost,
            COALESCE(sum(delivery_fee),0)::numeric AS fee
       FROM deliveries
      WHERE provider_id IS NOT NULL`,
  );
  const row = res.rows[0];
  const cost = toNum(row?.cost);
  const fee = toNum(row?.fee);
  return {
    total_3pl_deliveries: toNum(row?.n),
    provider_cost: cost,
    collected_fee: fee,
    margin: fee - cost,
  };
}
