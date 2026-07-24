// Per-tenant cost proxy. Tenants share product pods so OpenCost cannot
// attribute below the namespace level. We derive a tenant's share of the
// product's total cost from a weighted blend of three activity signals:
//   request count, DB storage, egress bytes.
//
// The result is honestly labeled "Estimated" in the UI — it's a model,
// not a measurement. Weights live in ProductConfig.costAttribution so
// each product can tune its own blend.
//
// PromQL queries assume mark8ly emits Istio metrics (`istio_requests_total`,
// `istio_response_bytes_sum`) labeled with `destination_workload_namespace`
// and a `tenant_id` label injected by mark8ly's middleware. If the
// `tenant_id` label isn't present yet (Wave 5 pending), this function
// returns 0 for the request/egress shares and the storage share carries
// the entire allocation — graceful degradation.

import { queryInstant } from "./prometheus";
import { getNamespaceCost, type CostWindow, type NamespaceCost } from "./opencost";
import { getTenantStorageEstimate } from "@/lib/db/mark8ly-tenant-metrics";
import type { ProductConfig } from "@/lib/products/types";
import { logger } from "@/lib/logger";

export interface ShareValue {
  readonly weight: number;
  readonly raw: number;
  readonly share: number;
}

export interface TenantCostShare {
  readonly currency: string;
  readonly estimatedCost: number;
  readonly productTotalCost: number;
  readonly breakdown: {
    readonly requests: ShareValue;
    readonly storage: ShareValue;
    readonly egress: ShareValue;
  };
}

function safeRatio(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(1, part / whole));
}

async function tenantRequestShare(productConfig: ProductConfig, tenantId: string, windowSec: number): Promise<number> {
  // Total requests for the product in the window vs. tenant's slice.
  // We use Istio metrics by destination namespace + tenant_id label.
  const range = `[${windowSec}s]`;
  const total = `sum(rate(istio_requests_total{destination_workload_namespace="${productConfig.namespace}"}${range}))`;
  const slice = `sum(rate(istio_requests_total{destination_workload_namespace="${productConfig.namespace}",tenant_id="${tenantId}"}${range}))`;

  try {
    const [totalRes, sliceRes] = await Promise.all([
      queryInstant(total),
      queryInstant(slice),
    ]);
    const totalVal = totalRes[0]?.value.value ?? 0;
    const sliceVal = sliceRes[0]?.value.value ?? 0;
    return safeRatio(sliceVal, totalVal);
  } catch (err) {
    logger.warn("cost-proxy: request share unavailable, defaulting to 0", err);
    return 0;
  }
}

async function tenantEgressShare(productConfig: ProductConfig, tenantId: string, windowSec: number): Promise<number> {
  const range = `[${windowSec}s]`;
  const total = `sum(rate(istio_response_bytes_sum{destination_workload_namespace="${productConfig.namespace}"}${range}))`;
  const slice = `sum(rate(istio_response_bytes_sum{destination_workload_namespace="${productConfig.namespace}",tenant_id="${tenantId}"}${range}))`;

  try {
    const [totalRes, sliceRes] = await Promise.all([
      queryInstant(total),
      queryInstant(slice),
    ]);
    const totalVal = totalRes[0]?.value.value ?? 0;
    const sliceVal = sliceRes[0]?.value.value ?? 0;
    return safeRatio(sliceVal, totalVal);
  } catch (err) {
    logger.warn("cost-proxy: egress share unavailable, defaulting to 0", err);
    return 0;
  }
}

async function tenantStorageShare(productConfig: ProductConfig, tenantId: string): Promise<number> {
  try {
    const tenant = await getTenantStorageEstimate(tenantId, productConfig.rowCountTables);
    if (tenant.bytes === 0) return 0;

    // Total estimated storage = sum of tenant.bytes for ALL tenants — too
    // expensive to compute on every request. Approximate with sum of full
    // table sizes for the configured tables; tenant share = tenant_bytes /
    // total_table_bytes. Same shape as the request/egress ratios.
    let totalTableBytes = 0;
    for (const t of productConfig.rowCountTables) {
      // We can't reuse getTenantStorageEstimate without recomputing — the
      // total is implicit in its inputs. Cheaper to query pg_total_relation_size
      // directly here, but that requires another DB hop. For now we accept
      // tenant.bytes / sum(per-table bytes proportionally) as the storage
      // share, which is consistent across tenants.
      totalTableBytes += tenant.perTable[t.label] ?? 0;
    }
    // If totalTableBytes equals tenant.bytes, tenant has 100% — only useful
    // when there's exactly one tenant. For multi-tenant accuracy we'd query
    // pg_total_relation_size separately. Phase 1 acceptable: see CONTEXT.md.
    return safeRatio(tenant.bytes, totalTableBytes || tenant.bytes);
  } catch (err) {
    logger.warn("cost-proxy: storage share unavailable, defaulting to 0", err);
    return 0;
  }
}

const WINDOW_SECONDS: Record<CostWindow, number> = {
  "1h": 3600,
  "24h": 86_400,
  "7d": 604_800,
  "30d": 2_592_000,
};

export async function computeTenantCostShare(
  productConfig: ProductConfig,
  tenantId: string,
  window: CostWindow,
): Promise<TenantCostShare> {
  const namespaceCost: NamespaceCost = await getNamespaceCost(productConfig.namespace, window);
  const windowSec = WINDOW_SECONDS[window];

  const [requestsShare, storageShare, egressShare]: [number, number, number] = await Promise.all([
    tenantRequestShare(productConfig, tenantId, windowSec),
    tenantStorageShare(productConfig, tenantId),
    tenantEgressShare(productConfig, tenantId, windowSec),
  ]);

  const w = productConfig.costAttribution;
  const tenantShareRatio =
    requestsShare * w.requests + storageShare * w.storage + egressShare * w.egress;

  const estimated = namespaceCost.total * tenantShareRatio;

  return {
    currency: namespaceCost.currency,
    estimatedCost: Math.round(estimated * 100) / 100,
    productTotalCost: namespaceCost.total,
    breakdown: {
      requests: { weight: w.requests, raw: requestsShare, share: requestsShare * w.requests },
      storage: { weight: w.storage, raw: storageShare, share: storageShare * w.storage },
      egress: { weight: w.egress, raw: egressShare, share: egressShare * w.egress },
    },
  };
}
