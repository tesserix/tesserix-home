// OpenCost allocation client. Reads OPENCOST_URL from env. In-cluster service,
// reachable from tesserix namespace once the egress allow rule lands (added in
// tesserix-k8s charts/apps/company/templates/network-policy.yaml).
//
// We aggregate by namespace because the unit of "product" maps 1:1 to namespace.
// Per-tenant cost is derived elsewhere (lib/metrics/cost-proxy.ts) since
// tenants share pods and OpenCost can't attribute below the namespace level.

import { logger } from "@/lib/logger";

const OPENCOST_URL = process.env.OPENCOST_URL;
const CACHE_TTL_MS = 60_000;

export type CostWindow = "1h" | "24h" | "7d" | "30d";

export interface NamespaceCost {
  readonly currency: string;
  readonly total: number;
  readonly cpu: number;
  readonly ram: number;
  readonly pv: number;
  readonly network: number;
  readonly loadBalancer: number;
}

interface CacheEntry {
  readonly storedAt: number;
  readonly result: NamespaceCost;
}

const cache = new Map<string, CacheEntry>();

function getCached(key: string): NamespaceCost | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function requireUrl(): string {
  if (!OPENCOST_URL) {
    throw new Error("OPENCOST_URL env not set");
  }
  return OPENCOST_URL;
}

interface AllocationRow {
  readonly cpuCost?: number;
  readonly ramCost?: number;
  readonly pvCost?: number;
  readonly networkCost?: number;
  readonly loadBalancerCost?: number;
  readonly totalCost?: number;
}

export async function getNamespaceCost(namespace: string, window: CostWindow): Promise<NamespaceCost> {
  const url = requireUrl();
  const cacheKey = `${namespace}:${window}`;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    window,
    aggregate: "namespace",
    accumulate: "true",
  });
  const res = await fetch(`${url}/allocation/compute?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    logger.error("opencost allocation query failed", { status: res.status, namespace, window });
    throw new Error(`opencost_unavailable: ${res.status}`);
  }
  const body = (await res.json()) as { code: number; data: Array<Record<string, AllocationRow>> };
  const rows = body.data?.[0] ?? {};
  const row = rows[namespace];

  const result: NamespaceCost = {
    currency: "USD", // OpenCost defaults; Phase 1 surfaces the field for UI conversion
    total: row?.totalCost ?? 0,
    cpu: row?.cpuCost ?? 0,
    ram: row?.ramCost ?? 0,
    pv: row?.pvCost ?? 0,
    network: row?.networkCost ?? 0,
    loadBalancer: row?.loadBalancerCost ?? 0,
  };
  cache.set(cacheKey, { storedAt: Date.now(), result });
  return result;
}

export function clearCache(): void {
  cache.clear();
}
