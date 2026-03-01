"use client";

import { useState, useEffect } from "react";
import {
  ScrollText,
  ShieldAlert,
  ShieldX,
  CalendarDays,
  Search,
  Trash2,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/admin/error-state";
import {
  useAuditLogs,
  useAuditLogSummary,
  useComplianceReport,
  useRetentionSettings,
  updateRetentionSettings,
  triggerCleanup,
  type AuditLog,
  type AuditSeverity,
  type AuditLogFilters,
  type RetentionSettings,
} from "@/lib/api/audit-logs";

function severityColor(severity: AuditSeverity) {
  switch (severity) {
    case "CRITICAL":
      return "destructive";
    case "ERROR":
      return "destructive";
    case "WARNING":
      return "warning";
    case "INFO":
    default:
      return "secondary";
  }
}

function StatCard({
  title,
  value,
  icon: Icon,
  loading,
}: {
  title: string;
  value: string | number;
  icon: React.ElementType;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            {loading ? (
              <Skeleton className="h-8 w-20 mt-1" />
            ) : (
              <p className="text-2xl font-bold">{value}</p>
            )}
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AuditLogDetailDialog({
  log,
  onClose,
}: {
  log: AuditLog;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-50 w-full max-w-2xl rounded-lg bg-background p-6 shadow-lg max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Audit Log Detail</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Timestamp</p>
              <p className="font-medium">
                {new Date(log.timestamp).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Severity</p>
              <Badge variant={severityColor(log.severity)}>{log.severity}</Badge>
            </div>
            <div>
              <p className="text-muted-foreground">Actor</p>
              <p className="font-medium">{log.actor}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Actor Type</p>
              <p className="font-medium">{log.actor_type}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Action</p>
              <p className="font-medium">{log.action}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Resource</p>
              <p className="font-medium">
                {log.resource_type}/{log.resource_id}
              </p>
            </div>
            {log.ip_address && (
              <div>
                <p className="text-muted-foreground">IP Address</p>
                <p className="font-medium">{log.ip_address}</p>
              </div>
            )}
            {log.tenant_id && (
              <div>
                <p className="text-muted-foreground">Tenant ID</p>
                <p className="font-medium font-mono text-xs">{log.tenant_id}</p>
              </div>
            )}
          </div>

          {log.metadata && Object.keys(log.metadata).length > 0 && (
            <div>
              <p className="text-sm text-muted-foreground mb-2">Metadata</p>
              <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto">
                {JSON.stringify(log.metadata, null, 2)}
              </pre>
            </div>
          )}

          {log.changes && Object.keys(log.changes).length > 0 && (
            <div>
              <p className="text-sm text-muted-foreground mb-2">Changes</p>
              <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto">
                {JSON.stringify(log.changes, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AuditLogsPage() {
  const [activeTab, setActiveTab] = useState<"events" | "compliance">("events");
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const [searchInput, setSearchInput] = useState("");
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);

  const { data: logs, isLoading: logsLoading, error: logsError, mutate: mutateLogs } = useAuditLogs(filters);
  const { data: summary, isLoading: summaryLoading } = useAuditLogSummary();
  const { data: compliance, isLoading: complianceLoading, error: complianceError } = useComplianceReport();
  const { data: retention, isLoading: retentionLoading, mutate: mutateRetention } = useRetentionSettings();

  function handleSearch() {
    setFilters((prev) => ({ ...prev, search: searchInput || undefined }));
  }

  function handleSeverityFilter(severity: AuditSeverity | "") {
    setFilters((prev) => ({
      ...prev,
      severity: severity || undefined,
    }));
  }

  async function handleRunCleanup() {
    setCleaningUp(true);
    await triggerCleanup();
    setCleaningUp(false);
    mutateLogs();
    mutateRetention();
  }

  async function handleSaveRetention(retentionDays: number, autoCleanup: boolean) {
    await updateRetentionSettings({
      retention_days: retentionDays,
      auto_cleanup_enabled: autoCleanup,
    });
    mutateRetention();
  }

  return (
    <>
      <AdminHeader
        title="Audit Logs"
        description="Monitor and review all system activity"
        icon={<ScrollText className="h-6 w-6 text-muted-foreground" />}
      />

      <main className="p-6 space-y-6">
        {/* Stats cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Total Events"
            value={summary?.total_events?.toLocaleString() ?? "\u2014"}
            icon={ScrollText}
            loading={summaryLoading}
          />
          <StatCard
            title="Critical Events"
            value={summary?.critical_events?.toLocaleString() ?? "\u2014"}
            icon={ShieldAlert}
            loading={summaryLoading}
          />
          <StatCard
            title="Failed Auth"
            value={summary?.failed_auth_attempts?.toLocaleString() ?? "\u2014"}
            icon={ShieldX}
            loading={summaryLoading}
          />
          <StatCard
            title="Events Today"
            value={summary?.events_today?.toLocaleString() ?? "\u2014"}
            icon={CalendarDays}
            loading={summaryLoading}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "events"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("events")}
          >
            Event Log
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "compliance"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("compliance")}
          >
            Compliance
          </button>
        </div>

        {activeTab === "events" && (
          <div className="space-y-4">
            {/* Filters */}
            <div className="flex flex-wrap gap-3">
              <div className="flex gap-2 flex-1 min-w-[200px]">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search logs..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    className="pl-9"
                  />
                </div>
                <Button variant="outline" onClick={handleSearch}>
                  Search
                </Button>
              </div>
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                onChange={(e) =>
                  handleSeverityFilter(e.target.value as AuditSeverity | "")
                }
                value={filters.severity || ""}
              >
                <option value="">All Severities</option>
                <option value="INFO">Info</option>
                <option value="WARNING">Warning</option>
                <option value="ERROR">Error</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>

            {/* Table */}
            {logsLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : logsError ? (
              <ErrorState message={logsError} onRetry={mutateLogs} />
            ) : !logs || logs.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground">No audit logs found.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                        Timestamp
                      </th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                        Actor
                      </th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                        Action
                      </th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                        Resource
                      </th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                        Severity
                      </th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                        IP
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr
                        key={log.id}
                        className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                        onClick={() => setSelectedLog(log)}
                      >
                        <td className="px-4 py-3 font-mono text-xs">
                          {new Date(log.timestamp).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">{log.actor}</td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {log.action}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {log.resource_type}/{log.resource_id}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={severityColor(log.severity)}>
                            {log.severity}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {log.ip_address || "\u2014"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === "compliance" && (
          <div className="space-y-6">
            {/* Compliance Report */}
            {complianceLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-48 w-full" />
              </div>
            ) : complianceError ? (
              <ErrorState message={complianceError} />
            ) : compliance ? (
              <Card>
                <CardHeader>
                  <CardTitle>Compliance Report</CardTitle>
                  <CardDescription>
                    Generated{" "}
                    {new Date(compliance.generated_at).toLocaleDateString()} |
                    Period: {new Date(compliance.period_start).toLocaleDateString()} -{" "}
                    {new Date(compliance.period_end).toLocaleDateString()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="text-center">
                      <p className="text-2xl font-bold">{compliance.compliance_score}%</p>
                      <p className="text-xs text-muted-foreground">Compliance Score</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold">{compliance.total_events.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">Total Events</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold">{compliance.security_events.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">Security Events</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold">{compliance.admin_actions.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">Admin Actions</p>
                    </div>
                  </div>

                  {compliance.findings.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Findings</h4>
                      <div className="space-y-2">
                        {compliance.findings.map((finding, i) => (
                          <div
                            key={i}
                            className="rounded-md border p-3 text-sm"
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant={severityColor(finding.severity)}>
                                {finding.severity}
                              </Badge>
                              <span className="font-medium">{finding.category}</span>
                            </div>
                            <p className="text-muted-foreground">{finding.description}</p>
                            <p className="text-xs mt-1">
                              <span className="font-medium">Recommendation:</span>{" "}
                              {finding.recommendation}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : null}

            {/* Retention Settings */}
            <RetentionCard
              retention={retention}
              loading={retentionLoading}
              onSave={handleSaveRetention}
              onCleanup={handleRunCleanup}
              cleaningUp={cleaningUp}
            />
          </div>
        )}

        {/* Detail Dialog */}
        {selectedLog && (
          <AuditLogDetailDialog
            log={selectedLog}
            onClose={() => setSelectedLog(null)}
          />
        )}
      </main>
    </>
  );
}

function RetentionCard({
  retention,
  loading,
  onSave,
  onCleanup,
  cleaningUp,
}: {
  retention: RetentionSettings | null;
  loading: boolean;
  onSave: (days: number, autoCleanup: boolean) => Promise<void>;
  onCleanup: () => Promise<void>;
  cleaningUp: boolean;
}) {
  const [days, setDays] = useState<number>(retention?.retention_days ?? 90);
  const [autoCleanup, setAutoCleanup] = useState(
    retention?.auto_cleanup_enabled ?? false
  );
  const [saving, setSaving] = useState(false);

  // Sync state when data loads
  useEffect(() => {
    if (retention) {
      setDays(retention.retention_days);
      setAutoCleanup(retention.auto_cleanup_enabled);
    }
  }, [retention]);

  async function handleSave() {
    setSaving(true);
    await onSave(days, autoCleanup);
    setSaving(false);
  }

  if (loading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Retention Settings</CardTitle>
        <CardDescription>Configure how long audit logs are retained</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <label className="text-sm font-medium">Retention Period (days)</label>
            <Input
              type="number"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              min={1}
              max={3650}
              className="mt-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="autoCleanup"
              checked={autoCleanup}
              onChange={(e) => setAutoCleanup(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="autoCleanup" className="text-sm">
              Auto cleanup
            </label>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Settings"}
          </Button>
          <Button
            variant="outline"
            onClick={onCleanup}
            disabled={cleaningUp}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {cleaningUp ? "Cleaning up..." : "Run Cleanup"}
          </Button>
        </div>
        {retention?.last_cleanup_at && (
          <p className="text-xs text-muted-foreground">
            Last cleanup: {new Date(retention.last_cleanup_at).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
