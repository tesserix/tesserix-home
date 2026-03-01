"use client";

import { useState, useEffect, useRef } from "react";
import {
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Activity,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import {
  useSystemHealth,
  groupServicesByApp,
  type OverallStatus,
  type ServiceHealth,
  type ServiceSummary,
  type Incident,
  type AppGroup,
} from "@/lib/api/system-health";

type StatusFilter = "all" | ServiceHealth;

function statusBannerStyle(status: OverallStatus) {
  switch (status) {
    case "operational":
      return {
        className:
          "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400",
        icon: <CheckCircle2 className="h-6 w-6" />,
        label: "All Systems Operational",
      };
    case "degraded":
      return {
        className:
          "bg-yellow-500/10 border-yellow-500/30 text-yellow-700 dark:text-yellow-400",
        icon: <AlertCircle className="h-6 w-6" />,
        label: "Degraded Performance",
      };
    case "outage":
      return {
        className:
          "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400",
        icon: <XCircle className="h-6 w-6" />,
        label: "System Outage",
      };
  }
}

function healthBadgeVariant(
  health: ServiceHealth
): "success" | "destructive" | "warning" | "secondary" {
  switch (health) {
    case "healthy":
      return "success";
    case "unhealthy":
      return "destructive";
    case "degraded":
      return "warning";
    case "unknown":
    default:
      return "secondary";
  }
}

function healthIcon(health: ServiceHealth) {
  switch (health) {
    case "healthy":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "unhealthy":
      return <XCircle className="h-4 w-4 text-red-500" />;
    case "degraded":
      return <AlertCircle className="h-4 w-4 text-yellow-500" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

function appGroupSummary(services: ServiceSummary[]) {
  const healthy = services.filter((s) => s.status === "healthy").length;
  const total = services.length;
  if (healthy === total)
    return { label: "All healthy", variant: "success" as const };
  const unhealthy = services.filter((s) => s.status === "unhealthy").length;
  if (unhealthy > 0)
    return { label: `${unhealthy} down`, variant: "destructive" as const };
  const degraded = services.filter((s) => s.status === "degraded").length;
  if (degraded > 0)
    return { label: `${degraded} degraded`, variant: "warning" as const };
  return {
    label: `${healthy}/${total} healthy`,
    variant: "secondary" as const,
  };
}

function ServiceRow({ service }: { service: ServiceSummary }) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="flex items-center gap-3 min-w-0">
        {healthIcon(service.status)}
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">
            {service.displayName}
          </p>
          <p className="text-xs text-muted-foreground">{service.category}</p>
        </div>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <div className="text-right hidden sm:block">
          <p className="text-xs font-mono text-muted-foreground">
            {service.responseTimeMs}ms
          </p>
          <p className="text-xs text-muted-foreground">
            {service.uptime30d.toFixed(2)}% uptime
          </p>
        </div>
        <Badge variant={healthBadgeVariant(service.status)}>
          {service.status}
        </Badge>
      </div>
    </div>
  );
}

function AppGroupSection({
  app,
  services,
}: {
  app: AppGroup;
  services: ServiceSummary[];
}) {
  if (services.length === 0) return null;

  const summary = appGroupSummary(services);

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h4 className="text-base font-semibold">{app}</h4>
            <Badge variant={summary.variant}>{summary.label}</Badge>
          </div>
          <span className="text-sm text-muted-foreground">
            {services.length} service{services.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="space-y-2">
          {services.map((svc) => (
            <ServiceRow key={svc.id} service={svc} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function IncidentCard({ incident }: { incident: Incident }) {
  return (
    <Card className="border-yellow-500/30">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
              <p className="font-medium text-sm truncate">{incident.title}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {incident.serviceName} &middot; Started{" "}
              {new Date(incident.startedAt).toLocaleString()}
            </p>
          </div>
          <Badge
            variant={
              incident.status === "investigating" ? "destructive" : "warning"
            }
          >
            {incident.status}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-48" />
      ))}
    </div>
  );
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "healthy", label: "Healthy" },
  { value: "degraded", label: "Degraded" },
  { value: "unhealthy", label: "Unhealthy" },
  { value: "unknown", label: "Unknown" },
];

const APP_GROUP_FILTERS: { value: AppGroup | "all"; label: string }[] = [
  { value: "all", label: "All Groups" },
  { value: "Platform", label: "Platform" },
  { value: "Mark8ly", label: "Mark8ly" },
  { value: "Infrastructure", label: "Infrastructure" },
];

function FilterChip({
  label,
  active,
  count,
  onClick,
}: {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
      }`}
    >
      {label}
      {count !== undefined && (
        <span
          className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs ${
            active
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-background text-muted-foreground"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export default function SystemHealthPage() {
  const { data, isLoading, error, mutate } = useSystemHealth();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [appGroupFilter, setAppGroupFilter] = useState<AppGroup | "all">(
    "all"
  );

  useEffect(() => {
    intervalRef.current = setInterval(() => mutate(), 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [mutate]);

  // Apply filters to services
  const allServices = data?.services ?? [];
  const filteredServices = allServices.filter((svc) => {
    if (statusFilter !== "all" && svc.status !== statusFilter) return false;
    return true;
  });
  const groups = groupServicesByApp(filteredServices);

  // Count services by status for filter chips
  const statusCounts: Record<StatusFilter, number> = {
    all: allServices.length,
    healthy: allServices.filter((s) => s.status === "healthy").length,
    degraded: allServices.filter((s) => s.status === "degraded").length,
    unhealthy: allServices.filter((s) => s.status === "unhealthy").length,
    unknown: allServices.filter((s) => s.status === "unknown").length,
  };

  // Count services by app group
  const allGroups = groupServicesByApp(allServices);
  const groupCounts: Record<AppGroup | "all", number> = {
    all: filteredServices.length,
    Platform: appGroupFilter === "all" || appGroupFilter === "Platform"
      ? groups.Platform.length
      : allGroups.Platform.length,
    Mark8ly: appGroupFilter === "all" || appGroupFilter === "Mark8ly"
      ? groups.Mark8ly.length
      : allGroups.Mark8ly.length,
    Infrastructure: appGroupFilter === "all" || appGroupFilter === "Infrastructure"
      ? groups.Infrastructure.length
      : allGroups.Infrastructure.length,
  };

  const activeIncidents =
    data?.incidents?.filter((i) => i.status !== "resolved") ?? [];

  // Determine which app groups to show
  const visibleGroups: AppGroup[] =
    appGroupFilter === "all"
      ? (["Platform", "Mark8ly", "Infrastructure"] as AppGroup[])
      : [appGroupFilter];

  return (
    <>
      <AdminHeader
        title="System Health"
        description="Monitor service status and active incidents"
        icon={<Activity className="h-6 w-6 text-muted-foreground" />}
      />

      <main className="p-6 space-y-6">
        {/* Refresh bar */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {data?.lastUpdated
              ? `Last updated: ${new Date(data.lastUpdated).toLocaleTimeString()}`
              : "Loading..."}
          </p>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        {isLoading ? (
          <PageSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={mutate} />
        ) : data ? (
          <>
            {/* Overall status banner */}
            {(() => {
              const banner = statusBannerStyle(data.status);
              return (
                <Card className={`border ${banner.className}`}>
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {banner.icon}
                        <div>
                          <h2 className="text-lg font-bold">{banner.label}</h2>
                          <p className="text-sm opacity-80">
                            {data.stats.healthyServices}/
                            {data.stats.totalServices} services healthy
                            &middot; Avg response{" "}
                            {data.stats.avgResponseMs.toFixed(0)}ms
                          </p>
                        </div>
                      </div>
                      <div className="text-right text-sm hidden sm:block">
                        <p className="font-mono text-lg font-bold">
                          {data.stats.overallUptime.toFixed(2)}%
                        </p>
                        <p className="text-xs opacity-70">Overall Uptime</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            {/* Stats cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">
                        {data.stats.healthyServices}
                      </p>
                      <p className="text-xs text-muted-foreground">Healthy</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
                      <AlertCircle className="h-5 w-5 text-yellow-500" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">
                        {data.stats.degradedServices}
                      </p>
                      <p className="text-xs text-muted-foreground">Degraded</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/10">
                      <XCircle className="h-5 w-5 text-red-500" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">
                        {data.stats.unhealthyServices}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Unhealthy
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                      <Activity className="h-5 w-5 text-blue-500" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">
                        {data.stats.avgResponseMs.toFixed(0)}ms
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Avg Latency
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Active incidents */}
            {activeIncidents.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                  Active Incidents ({activeIncidents.length})
                </h3>
                <div className="space-y-3">
                  {activeIncidents.map((incident) => (
                    <IncidentCard key={incident.id} incident={incident} />
                  ))}
                </div>
              </div>
            )}

            {/* Filter chips + Services */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Services</h3>
                <p className="text-sm text-muted-foreground">
                  {filteredServices.length} of {allServices.length} services
                </p>
              </div>

              {/* Status filter chips */}
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <span className="text-sm font-medium text-muted-foreground self-center mr-1">
                    Status:
                  </span>
                  {STATUS_FILTERS.map((f) =>
                    // Hide "unknown" chip if no unknown services
                    f.value === "unknown" && statusCounts.unknown === 0 ? null : (
                      <FilterChip
                        key={f.value}
                        label={f.label}
                        active={statusFilter === f.value}
                        count={statusCounts[f.value]}
                        onClick={() => setStatusFilter(f.value)}
                      />
                    )
                  )}
                </div>

                {/* App group filter chips */}
                <div className="flex flex-wrap gap-2">
                  <span className="text-sm font-medium text-muted-foreground self-center mr-1">
                    Group:
                  </span>
                  {APP_GROUP_FILTERS.map((f) => (
                    <FilterChip
                      key={f.value}
                      label={f.label}
                      active={appGroupFilter === f.value}
                      count={groupCounts[f.value]}
                      onClick={() => setAppGroupFilter(f.value)}
                    />
                  ))}
                </div>
              </div>

              {filteredServices.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center">
                    <p className="text-muted-foreground">
                      No services match the selected filters.
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        setStatusFilter("all");
                        setAppGroupFilter("all");
                      }}
                    >
                      Clear filters
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                visibleGroups.map((app) => (
                  <AppGroupSection
                    key={app}
                    app={app}
                    services={groups[app]}
                  />
                ))
              )}
            </div>

            {/* No incidents message */}
            {activeIncidents.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center">
                  <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
                  <p className="text-muted-foreground">
                    No active incidents. All systems running normally.
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        ) : null}
      </main>
    </>
  );
}
