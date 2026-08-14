"use client";

import useSWR from "swr";
import type { ProductMetrics } from "@/lib/metrics/product-metrics";
import type { TenantMetrics } from "@/lib/metrics/tenant-metrics";
import type { Window } from "@/lib/metrics/window";

// Attached to the thrown Error so callers can distinguish *why* a request
// failed — a 501 "not_instrumented" (product has no KPI branch) reads very
// differently from a timeout or a 404, but a bare Error message collapses
// them all into the same catch. See useProductKpis below.
export interface FetchError extends Error {
  status?: number;
  code?: string;
}

const fetcher = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(body.error ?? `HTTP ${res.status}`) as FetchError;
    err.status = res.status;
    err.code = body.error;
    throw err;
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

// Product-scoped business KPI values keyed by tile key (see businessKpiTiles in
// lib/products/configs.ts). Empty {} for products without a wired KPI source.
export type ProductKpis = Record<string, number>;

export function useProductKpis(productId: string) {
  return useSWR<ProductKpis, FetchError>(
    productId ? `/api/admin/apps/${productId}/kpis` : null,
    fetcher as (u: string) => Promise<ProductKpis>,
    { revalidateOnFocus: false, dedupingInterval: 30_000, shouldRetryOnError: false },
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

export interface DashboardCounts {
  tenants: { total: number; active: number };
  stores: { total: number };
  leads: { total: number; by_status: Record<string, number> };
  apps: { active: number };
  generated_at: string;
}

export function useDashboardCounts() {
  return useSWR<DashboardCounts>(
    "/api/admin/dashboard",
    fetcher as (u: string) => Promise<DashboardCounts>,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}
