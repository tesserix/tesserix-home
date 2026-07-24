"use client";

import useSWR from "swr";
import type { AuditEvent } from "@/components/admin/audit/audit-row";

const fetcher = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
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

export function useCriticalEventCount(productId: string) {
  return useSWR<{ summary: { criticalLast24h: number } }>(
    `/api/admin/apps/${productId}/audit-logs?severity=critical&since_hours=24`,
    fetcher as (u: string) => Promise<{ summary: { criticalLast24h: number } }>,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );
}
