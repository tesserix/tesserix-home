"use client";

import { useState } from "react";
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";

import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { RefreshControl } from "@/components/admin/metrics/refresh-control";
import { AuditRow } from "@/components/admin/audit/audit-row";
import { formatNumber } from "@/components/admin/metrics/format";
import { useAuditLogs, type AuditFilters } from "@/lib/admin/use-audit";
import type { ProductConfig } from "@/lib/products/types";

interface Props {
  config: ProductConfig;
  initialSeverity?: string;
}

const ALL = "all";

const SEVERITIES = [
  { value: ALL, label: "All severities" },
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "critical", label: "Critical" },
];

const STATUSES = [
  { value: ALL, label: "All statuses" },
  { value: "success", label: "Success" },
  { value: "failure", label: "Failure" },
];

const TIME_WINDOWS = [
  { value: 1, label: "Last 1 hour" },
  { value: 24, label: "Last 24 hours" },
  { value: 168, label: "Last 7 days" },
  { value: 720, label: "Last 30 days" },
];

export function AuditLogsPageLayout({ config, initialSeverity = "" }: Props) {
  const [filters, setFilters] = useState<AuditFilters>({
    severity: initialSeverity || undefined,
    sinceHours: 168,
  });
  const { data, error, isLoading, isValidating, mutate } = useAuditLogs(config.id, filters);

  function update<K extends keyof AuditFilters>(key: K, value: AuditFilters[K] | undefined) {
    setFilters((f) => ({ ...f, [key]: value || undefined }));
  }

  function pickEnum(value: string): string | undefined {
    return value === ALL || !value ? undefined : value;
  }

  const rows = data?.rows ?? [];

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Audit logs" />
      <div className="flex-1 space-y-6 p-6">
        <div className="flex items-center justify-end">
          <RefreshControl onRefresh={async () => { await mutate(); }} loading={isValidating} />
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile
            label="Critical (24h)"
            value={data ? formatNumber(data.summary.criticalLast24h) : "—"}
            loading={isLoading}
          />
          <KpiTile
            label="Events shown"
            value={data ? formatNumber(rows.length) : "—"}
            loading={isLoading}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
          <Select
            value={filters.severity ?? ALL}
            onValueChange={(v) => update("severity", pickEnum(v))}
          >
            <SelectTrigger className="h-9 w-44 text-xs">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              {SEVERITIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.status ?? ALL}
            onValueChange={(v) => update("status", pickEnum(v))}
          >
            <SelectTrigger className="h-9 w-36 text-xs">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(filters.sinceHours ?? 168)}
            onValueChange={(v) => update("sinceHours", Number(v))}
          >
            <SelectTrigger className="h-9 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_WINDOWS.map((s) => (
                <SelectItem key={s.value} value={String(s.value)}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Action contains…"
            value={filters.action ?? ""}
            onChange={(e) => update("action", e.target.value)}
            className="h-9 w-48 text-xs"
          />
          <Input
            placeholder="Resource type"
            value={filters.resourceType ?? ""}
            onChange={(e) => update("resourceType", e.target.value)}
            className="h-9 w-36 text-xs"
          />
          <Input
            placeholder="Actor email contains…"
            value={filters.actorEmail ?? ""}
            onChange={(e) => update("actorEmail", e.target.value)}
            className="h-9 w-56 text-xs"
          />
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load audit logs.
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="w-8 px-4 py-3"></th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Resource</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Tenant</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !isLoading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No audit events match these filters.
                  </td>
                </tr>
              ) : (
                rows.map((event) => <AuditRow key={event.id} event={event} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
