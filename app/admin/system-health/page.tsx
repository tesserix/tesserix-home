"use client";

import { useCallback, useState } from "react";
import {
  RefreshCw,
  AlertTriangle,
  Clock,
  Activity,
  Zap,
  Shield,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  useSystemHealth,
  groupServicesByApp,
  type OverallStatus,
  type ServiceHealth,
  type ServiceSummary,
  type Incident,
  type AppGroup,
} from "@/lib/api/system-health";
import { Button, Badge, Card, CardContent, Skeleton, ErrorState } from "@tesserix/web";
import { useVisibilityInterval } from "@/hooks/use-visibility-interval";

function statusIndicator(status: OverallStatus) {
  switch (status) {
    case "operational":
      return { color: "bg-success", label: "All Systems Operational" };
    case "degraded":
      return { color: "bg-warning", label: "Degraded Performance" };
    case "outage":
      return { color: "bg-error", label: "System Outage" };
  }
}

function healthDot(health: ServiceHealth) {
  switch (health) {
    case "healthy":
      return "bg-success";
    case "unhealthy":
      return "bg-error";
    case "degraded":
      return "bg-warning";
    default:
      return "bg-muted-foreground";
  }
}

function healthLabel(health: ServiceHealth): string {
  switch (health) {
    case "healthy":
      return "Healthy";
    case "unhealthy":
      return "Unhealthy";
    case "degraded":
      return "Degraded";
    default:
      return "Unknown";
  }
}

const GROUP_ICONS: Record<AppGroup, React.ReactNode> = {
  Core: <Shield className="h-4 w-4" />,
  Application: <Activity className="h-4 w-4" />,
  Communication: <Zap className="h-4 w-4" />,
  Supporting: <Clock className="h-4 w-4" />,
};

function ServiceCard({ service }: { service: ServiceSummary }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5 hover:bg-muted/50 transition-colors">
      <span
        className={`h-2 w-2 rounded-full shrink-0 ${healthDot(service.status)}`}
        aria-hidden="true"
      />
      <span className="sr-only">{healthLabel(service.status)}.</span>
      <span className="text-sm font-medium truncate flex-1">
        {service.displayName}
      </span>
      <span className="text-xs font-mono text-muted-foreground shrink-0">
        {service.responseTimeMs}ms
      </span>
      <span className="text-xs text-muted-foreground shrink-0 w-16 text-right">
        {service.uptime30d.toFixed(1)}%
      </span>
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

  const healthy = services.filter((s) => s.status === "healthy").length;
  const allHealthy = healthy === services.length;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-muted-foreground">{GROUP_ICONS[app]}</span>
          <h3 className="text-sm font-semibold flex-1">{app}</h3>
          <Badge
            variant={allHealthy ? "success" : "warning"}
            className="text-[10px] h-5"
          >
            {healthy}/{services.length}
          </Badge>
        </div>
        <div className="space-y-1.5">
          {services.map((svc) => (
            <ServiceCard key={svc.id} service={svc} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function IncidentBanner({ incidents }: { incidents: Incident[] }) {
  if (incidents.length === 0) return null;
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
          <span className="text-sm font-semibold">
            {incidents.length} Active Incident{incidents.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="space-y-2">
          {incidents.map((incident) => (
            <div
              key={incident.id}
              className="flex items-center justify-between text-sm"
            >
              <div className="min-w-0">
                <span className="font-medium">{incident.title}</span>
                <span className="text-muted-foreground">
                  {" "}&middot; {incident.serviceName}
                </span>
              </div>
              <Badge
                variant={
                  incident.status === "investigating"
                    ? "destructive"
                    : "warning"
                }
                className="text-[10px] h-5 shrink-0"
              >
                {incident.status}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    </div>
  );
}

export default function SystemHealthPage() {
  const { data, isLoading, error, mutate } = useSystemHealth();

  const [statusFilter, setStatusFilter] = useState<ServiceHealth | "all">(
    "all"
  );

  const refresh = useCallback(() => {
    mutate();
  }, [mutate]);
  useVisibilityInterval(refresh, 30_000);

  const allServices = data?.services ?? [];
  const filteredServices =
    statusFilter === "all"
      ? allServices
      : allServices.filter((svc) => svc.status === statusFilter);
  const groups = groupServicesByApp(filteredServices);

  const activeIncidents =
    data?.incidents?.filter((i) => i.status !== "resolved") ?? [];

  const statusCounts = {
    healthy: allServices.filter((s) => s.status === "healthy").length,
    degraded: allServices.filter((s) => s.status === "degraded").length,
    unhealthy: allServices.filter((s) => s.status === "unhealthy").length,
  };

  return (
    <>
      <AdminHeader
        title="System Health"
        description="Monitor service status and incidents"
        icon={<Activity className="h-6 w-6 text-muted-foreground" />}
      />

      <main className="p-6 space-y-4">
        {isLoading ? (
          <PageSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={mutate} />
        ) : data ? (
          <>
            {/* Status bar */}
            {(() => {
              const indicator = statusIndicator(data.status);
              return (
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-3 w-3 rounded-full ${indicator.color} animate-pulse`}
                      aria-hidden="true"
                    />
                    <div>
                      <p className="text-sm font-semibold">{indicator.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {data.stats.healthyServices}/{data.stats.totalServices} healthy
                        &middot; {data.stats.avgResponseMs.toFixed(0)}ms avg
                        &middot; {data.stats.overallUptime.toFixed(2)}% uptime
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusCounts.unhealthy > 0 && (
                      <Badge variant="destructive" className="text-[10px] h-5">
                        {statusCounts.unhealthy} down
                      </Badge>
                    )}
                    {statusCounts.degraded > 0 && (
                      <Badge variant="warning" className="text-[10px] h-5">
                        {statusCounts.degraded} degraded
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => mutate()}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })()}

            {/* Active incidents */}
            <IncidentBanner incidents={activeIncidents} />

            {/* Quick filter */}
            {(statusCounts.degraded > 0 || statusCounts.unhealthy > 0) && (
              <div className="flex gap-2">
                {(["all", "healthy", "degraded", "unhealthy"] as const).map(
                  (f) => (
                    <Button
                      key={f}
                      variant={statusFilter === f ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-xs rounded-full"
                      onClick={() => setStatusFilter(f)}
                    >
                      {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                    </Button>
                  )
                )}
              </div>
            )}

            {/* Service groups */}
            <div className="grid gap-4 sm:grid-cols-2">
              {(["Core", "Application", "Communication", "Supporting"] as AppGroup[]).map(
                (app) => (
                  <AppGroupSection
                    key={app}
                    app={app}
                    services={groups[app]}
                  />
                )
              )}
            </div>

            {/* Last updated */}
            <p className="text-xs text-muted-foreground text-center">
              Last updated{" "}
              {data.lastUpdated
                ? new Date(data.lastUpdated).toLocaleTimeString()
                : "—"}
            </p>
          </>
        ) : null}
      </main>
    </>
  );
}
