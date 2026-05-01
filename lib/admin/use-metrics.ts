"use client";

import useSWR from "swr";
import type { ProductMetrics } from "@/lib/metrics/product-metrics";
import type { TenantMetrics } from "@/lib/metrics/tenant-metrics";
import type { Window } from "@/lib/metrics/window";

const fetcher = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

export function useProductMetrics(productId: string, window: Window) {
  return useSWR<ProductMetrics>(
    `/api/admin/apps/${productId}/metrics?window=${window}`,
    fetcher as (u: string) => Promise<ProductMetrics>,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}

export function useTenantMetrics(productId: string, tenantId: string, window: Window) {
  return useSWR<TenantMetrics>(
    `/api/admin/apps/${productId}/tenants/${tenantId}/metrics?window=${window}`,
    fetcher as (u: string) => Promise<TenantMetrics>,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}

export interface TenantIdentity {
  id: string;
  name: string;
  owner_email: string;
  status: "active" | "suspended" | "archived";
  created_at: string;
  updated_at: string;
}

export function useTenantIdentity(tenantId: string) {
  return useSWR<{ tenant: TenantIdentity }>(
    `/api/admin/tenants/${tenantId}`,
    fetcher as (u: string) => Promise<{ tenant: TenantIdentity }>,
    { revalidateOnFocus: false },
  );
}
