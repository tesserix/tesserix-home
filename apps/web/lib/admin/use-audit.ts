"use client";

import useSWR from "swr";

// What is left of this module after #139.
//
// It used to carry `useAuditLogs` + `AuditFilters` + `AuditLogsResponse` for
// `/admin/apps/mark8ly/audit-logs`, which is now a redirect to the console's
// estate-wide audit timeline. `useCriticalEventCount` survives ALONE because
// its consumer does not: `product-overview-layout.tsx` renders a critical-events
// KPI tile on every product overview, and those pages are not being retired.
//
// So the endpoint keeps a `summary` and has lost its `rows`/`filterOptions` —
// see the route's own header. This hook reads the one field still consumed.

// Mirrors lib/admin/use-metrics.ts's FetchError — callers need to distinguish a
// permanent 404 (product has no audit source) from a transient failure.
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

/**
 * `criticalLast24h` is null for a product whose audit has no severity concept
 * (kora, homechef) — "not measured" is a different claim from "measured zero",
 * and `formatNumber` renders the null as an em dash rather than as 0.
 */
export interface CriticalEventSummary {
  summary: { criticalLast24h: number | null };
}

export function useCriticalEventCount(productId: string) {
  return useSWR<CriticalEventSummary, FetchError>(
    `/api/admin/apps/${productId}/audit-logs?severity=critical&since_hours=24`,
    fetcher as (u: string) => Promise<CriticalEventSummary>,
    { revalidateOnFocus: false, dedupingInterval: 60_000, shouldRetryOnError: false },
  );
}
