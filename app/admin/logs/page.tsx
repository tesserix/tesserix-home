"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ScrollText,
  RefreshCw,
  Loader2,
  ChevronDown,
  Play,
  Square,
  AlertTriangle,
  Info,
  AlertCircle,
  Bug,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
} from "@tesserix/web";
import { apiFetch } from "@/lib/api/use-api";
import { SERVICE_REGISTRY } from "@/lib/releases/services";

// ─── Types ───

type Severity = "DEFAULT" | "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

interface LogEntry {
  insertId: string;
  timestamp: string;
  severity: Severity;
  message: string;
  revision?: string;
}

interface LogsResponse {
  entries: LogEntry[];
  nextPageToken?: string;
  error?: string;
}

// ─── Constants ───

const SEVERITIES: Array<{ value: Severity; label: string }> = [
  { value: "DEFAULT", label: "All" },
  { value: "DEBUG", label: "Debug" },
  { value: "INFO", label: "Info" },
  { value: "WARNING", label: "Warning" },
  { value: "ERROR", label: "Error" },
  { value: "CRITICAL", label: "Critical" },
];

const SEVERITY_CONFIG: Record<
  Severity,
  { color: string; badge: string; icon: React.FC<{ className?: string }> }
> = {
  DEFAULT: {
    color: "text-foreground",
    badge: "bg-muted text-muted-foreground",
    icon: Info,
  },
  DEBUG: {
    color: "text-muted-foreground",
    badge: "bg-muted text-muted-foreground",
    icon: Bug,
  },
  INFO: {
    color: "text-foreground",
    badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    icon: Info,
  },
  WARNING: {
    color: "text-yellow-700 dark:text-yellow-400",
    badge: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    icon: AlertTriangle,
  },
  ERROR: {
    color: "text-red-600 dark:text-red-400",
    badge: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    icon: AlertCircle,
  },
  CRITICAL: {
    color: "text-red-700 dark:text-red-300 font-bold",
    badge: "bg-red-200 text-red-800 dark:bg-red-900/50 dark:text-red-300",
    icon: AlertCircle,
  },
};

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return ts;
  }
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const cfg = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.DEFAULT;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.badge}`}
    >
      {severity === "DEFAULT" ? "LOG" : severity}
    </span>
  );
}

// ─── Main Page ───

export default function LogsPage() {
  const [service, setService] = useState<string>(
    SERVICE_REGISTRY[0]?.name ?? ""
  );
  const [severity, setSeverity] = useState<Severity>("DEFAULT");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(
    async (append = false) => {
      if (!service) return;
      if (!append) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      const params = new URLSearchParams({ service, severity, limit: "100" });
      if (append && nextPageToken) params.set("pageToken", nextPageToken);

      const res = await apiFetch<LogsResponse>(`/api/logs?${params.toString()}`);
      if (res.error) {
        setError(res.error);
      } else if (res.data) {
        if (append) {
          setEntries((prev) => [...prev, ...(res.data?.entries ?? [])]);
        } else {
          setEntries(res.data.entries ?? []);
        }
        setNextPageToken(res.data.nextPageToken);
      }

      if (!append) setLoading(false);
      else setLoadingMore(false);
    },
    [service, severity, nextPageToken]
  );

  // Reset and fetch when service/severity changes
  useEffect(() => {
    setEntries([]);
    setNextPageToken(undefined);
    fetchLogs(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, severity]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        setEntries([]);
        setNextPageToken(undefined);
        fetchLogs(false);
      }, 10_000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchLogs]);

  return (
    <>
      <AdminHeader
        title="Cloud Run Logs"
        description="Live logs from Cloud Run services via Cloud Logging"
        icon={ScrollText}
      />

      <main className="p-6 space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Service selector */}
        <div className="relative">
          <select
            value={service}
            onChange={(e) => setService(e.target.value)}
            className="h-9 appearance-none rounded-md border bg-background px-3 pr-8 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {SERVICE_REGISTRY.map((s) => (
              <option key={s.name} value={s.name}>
                {s.displayName}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>

        {/* Severity filter */}
        <div className="flex items-center gap-1 rounded-lg border p-0.5">
          {SEVERITIES.map((s) => (
            <button
              key={s.value}
              onClick={() => setSeverity(s.value)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                severity === s.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              autoRefresh
                ? "border-green-500/50 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
                : "bg-background text-muted-foreground hover:text-foreground"
            }`}
          >
            {autoRefresh ? (
              <>
                <Square className="h-3 w-3" />
                Live (10s)
              </>
            ) : (
              <>
                <Play className="h-3 w-3" />
                Auto-refresh
              </>
            )}
          </button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchLogs(false)}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span className="ml-1">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Summary */}
      {!loading && (
        <div className="mb-3 text-sm text-muted-foreground">
          {entries.length} log entries for{" "}
          <span className="font-mono font-medium text-foreground">{service}</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <Card className="mb-4 border-destructive/30">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-medium text-destructive">Failed to load logs</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-1.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      )}

      {/* Log entries */}
      {!loading && entries.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {entries.map((entry) => {
                const cfg =
                  SEVERITY_CONFIG[entry.severity] ?? SEVERITY_CONFIG.DEFAULT;
                return (
                  <div
                    key={entry.insertId}
                    className="group flex items-start gap-3 px-4 py-2 hover:bg-muted/30 transition-colors"
                  >
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground pt-0.5 w-[86px]">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                    <span className="shrink-0 pt-0.5">
                      <SeverityBadge severity={entry.severity} />
                    </span>
                    <p
                      className={`flex-1 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap ${cfg.color}`}
                    >
                      {entry.message}
                    </p>
                    {entry.revision && (
                      <span className="hidden group-hover:inline shrink-0 font-mono text-[10px] text-muted-foreground pt-0.5">
                        {entry.revision}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!loading && !error && entries.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <ScrollText className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No log entries found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try a different service or severity filter
            </p>
          </CardContent>
        </Card>
      )}

      {/* Load more */}
      {!loading && nextPageToken && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchLogs(true)}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 mr-1" />
            )}
            Load more
          </Button>
        </div>
      )}
      </main>
    </>
  );
}
