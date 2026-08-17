"use client";

import useSWR from "swr";

import type { AuditEvent } from "@/components/admin/audit/audit-row";

// Audit reads for the admin surface.
//
// `useAuditLogs` was removed by #139 when `/admin/apps/mark8ly/audit-logs` was
// retired into the console's estate-wide timeline. It is BACK, along with that
// page: the console's audit surface stays exactly as it is, and the admin page
// it replaced runs beside it until the console app is complete. Both read the
// same endpoint — the console asks for `entries`, this asks for `rows`.
//
// `useCriticalEventCount` never left: `product-overview-layout.tsx` renders a
// critical-events KPI tile on every product overview.

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

export interface AuditLogsResponse {
  summary: { criticalLast24h: number };
  filterOptions: { actions: string[]; resourceTypes: string[] };
  rows: AuditEvent[];
  sinceHours: number;
  generatedAt: string;
}

export interface AuditFilters {
  severity?: string;
  status?: string;
  action?: string;
  resourceType?: string;
  actorEmail?: string;
  sinceHours?: number;
}

function buildKey(productId: string, filters: AuditFilters): string {
  const qs = new URLSearchParams();
  if (filters.severity) qs.set("severity", filters.severity);
  if (filters.status) qs.set("status", filters.status);
  if (filters.action) qs.set("action", filters.action);
  if (filters.resourceType) qs.set("resource_type", filters.resourceType);
  if (filters.actorEmail) qs.set("actor_email", filters.actorEmail);
  if (filters.sinceHours) qs.set("since_hours", String(filters.sinceHours));
  // Opt in to the mark8ly-shaped `rows` + `filterOptions`. The endpoint serves
  // the console's merged `entries` by default and only pays for this page's
  // extra two DISTINCT scans when this page is the one asking.
  qs.set("include", "rows");
  const q = qs.toString();
  return `/api/admin/apps/${productId}/audit-logs${q ? `?${q}` : ""}`;
}

export function useAuditLogs(productId: string, filters: AuditFilters) {
  return useSWR<AuditLogsResponse>(
    buildKey(productId, filters),
    fetcher as (u: string) => Promise<AuditLogsResponse>,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}

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
