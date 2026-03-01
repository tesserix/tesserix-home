"use client";

import {
  Building2,
  Ticket,
  DollarSign,
  ArrowRight,
  Activity,
  Plus,
  Eye,
  HeartPulse,
  ScrollText,
  CreditCard,
  Settings,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { AdminHeader } from "@/components/admin/header";
import { StatsCard } from "@/components/admin/stats-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import { useTenants, type Tenant } from "@/lib/api/tenants";
import { useTickets } from "@/lib/api/tickets";
import { useSubscriptionStats } from "@/lib/api/subscriptions";
import { useSystemHealth } from "@/lib/api/system-health";
import { useAuditLogs, type AuditLog, type AuditSeverity } from "@/lib/api/audit-logs";

function getStatusColor(status: string) {
  switch (status?.toLowerCase()) {
    case "active":
    case "resolved":
      return "success";
    case "pending":
    case "in_progress":
    case "in-progress":
      return "warning";
    case "open":
      return "info";
    default:
      return "secondary";
  }
}

function severityColor(severity: AuditSeverity) {
  switch (severity) {
    case "CRITICAL":
    case "ERROR":
      return "destructive";
    case "WARNING":
      return "warning";
    case "INFO":
    default:
      return "secondary";
  }
}

function StatsLoadingSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RecentListSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

const QUICK_ACTIONS = [
  {
    label: "Create New Tenant",
    href: "/admin/apps/mark8ly/tenants",
    icon: Plus,
    color: "text-blue-500",
  },
  {
    label: "View Tickets",
    href: "/admin/apps/mark8ly/tickets",
    icon: Eye,
    color: "text-orange-500",
  },
  {
    label: "System Health",
    href: "/admin/system-health",
    icon: HeartPulse,
    color: "text-green-500",
  },
  {
    label: "Audit Logs",
    href: "/admin/audit-logs",
    icon: ScrollText,
    color: "text-purple-500",
  },
  {
    label: "Manage Billing",
    href: "/admin/apps/mark8ly/billing",
    icon: CreditCard,
    color: "text-emerald-500",
  },
  {
    label: "Settings",
    href: "/admin/settings",
    icon: Settings,
    color: "text-gray-500",
  },
];

export default function DashboardPage() {
  const {
    data: tenantsData,
    isLoading: tenantsLoading,
    error: tenantsError,
    mutate: mutateTenants,
  } = useTenants({ limit: 4 });
  const { data: openTicketsData } = useTickets({ status: "open", limit: 1 });
  const { data: subscriptionStats } = useSubscriptionStats();
  const { data: healthData, isLoading: healthLoading } = useSystemHealth();
  const {
    data: auditLogs,
    isLoading: auditLoading,
    error: auditError,
    mutate: mutateAudit,
  } = useAuditLogs({ limit: 5 });

  const totalTenants = tenantsData?.total ?? 0;
  const openTickets = openTicketsData?.total ?? 0;
  const mrr = subscriptionStats?.mrr ?? 0;
  const recentTenants = tenantsData?.data ?? [];
  const recentAuditLogs = auditLogs ?? [];

  const healthStats = healthData?.stats;
  const overallStatus = healthData?.status;

  function getSystemHealthLabel() {
    if (healthLoading) return "...";
    if (!overallStatus) return "Unknown";
    if (overallStatus === "operational") return "All Operational";
    if (overallStatus === "degraded") {
      const count = (healthStats?.degradedServices ?? 0) + (healthStats?.unhealthyServices ?? 0);
      return `${count} service${count !== 1 ? "s" : ""} degraded`;
    }
    const count = healthStats?.unhealthyServices ?? 0;
    return `${count} service${count !== 1 ? "s" : ""} down`;
  }

  return (
    <>
      <AdminHeader title="Dashboard" description="Overview of your platform" />

      <main className="p-6 space-y-6">
        {/* Row 1 — Stats Grid */}
        {tenantsLoading || healthLoading ? (
          <StatsLoadingSkeleton />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatsCard
              title="Active Stores"
              value={totalTenants}
              description="Across all apps"
              icon={<Building2 className="h-4 w-4" />}
            />
            <StatsCard
              title="Monthly Revenue"
              value={`$${(mrr / 100).toLocaleString()}`}
              description="MRR"
              icon={<DollarSign className="h-4 w-4" />}
            />
            <StatsCard
              title="Open Tickets"
              value={openTickets}
              description="Requires attention"
              icon={<Ticket className="h-4 w-4" />}
            />
            <StatsCard
              title="System Health"
              value={getSystemHealthLabel()}
              description={
                overallStatus === "operational"
                  ? `${healthStats?.totalServices ?? 0} services monitored`
                  : "Check system health page"
              }
              icon={<Activity className="h-4 w-4" />}
            />
          </div>
        )}

        {/* Row 2 — Quick Actions + System Health Summary */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Quick Actions */}
          <Card>
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
              <CardDescription>Common management tasks</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                {QUICK_ACTIONS.map((action) => (
                  <Link
                    key={action.href}
                    href={action.href}
                    className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                  >
                    <action.icon className={`h-4 w-4 ${action.color}`} />
                    <span className="text-sm font-medium">{action.label}</span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* System Health Summary */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>System Health</CardTitle>
                <CardDescription>Service status overview</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/admin/system-health">
                  Details
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {healthLoading ? (
                <RecentListSkeleton />
              ) : !healthData ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  Unable to fetch health data
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    {overallStatus === "operational" ? (
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                    ) : overallStatus === "degraded" ? (
                      <AlertTriangle className="h-5 w-5 text-yellow-500" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-500" />
                    )}
                    <span className="font-medium capitalize">
                      {overallStatus}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="rounded-lg bg-green-500/10 p-3">
                      <p className="text-2xl font-bold text-green-600">
                        {healthStats?.healthyServices ?? 0}
                      </p>
                      <p className="text-xs text-muted-foreground">Healthy</p>
                    </div>
                    <div className="rounded-lg bg-yellow-500/10 p-3">
                      <p className="text-2xl font-bold text-yellow-600">
                        {healthStats?.degradedServices ?? 0}
                      </p>
                      <p className="text-xs text-muted-foreground">Degraded</p>
                    </div>
                    <div className="rounded-lg bg-red-500/10 p-3">
                      <p className="text-2xl font-bold text-red-600">
                        {healthStats?.unhealthyServices ?? 0}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Unhealthy
                      </p>
                    </div>
                  </div>
                  {healthData.incidents.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-muted-foreground">
                        Active Incidents
                      </p>
                      {healthData.incidents
                        .filter((i) => i.status !== "resolved")
                        .slice(0, 3)
                        .map((incident) => (
                          <div
                            key={incident.id}
                            className="flex items-center justify-between rounded-md border p-2 text-sm"
                          >
                            <div>
                              <p className="font-medium">{incident.title}</p>
                              <p className="text-xs text-muted-foreground">
                                {incident.serviceName}
                              </p>
                            </div>
                            <Badge
                              variant={
                                incident.status === "investigating"
                                  ? "destructive"
                                  : "warning"
                              }
                            >
                              {incident.status}
                            </Badge>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Row 3 — Recent Activity */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Recent Stores */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Stores</CardTitle>
                <CardDescription>Newly onboarded businesses</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/admin/apps/mark8ly">
                  View all
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {tenantsLoading ? (
                <RecentListSkeleton />
              ) : tenantsError ? (
                <ErrorState message={tenantsError} onRetry={mutateTenants} />
              ) : recentTenants.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No stores yet
                </p>
              ) : (
                <div className="space-y-4">
                  {recentTenants.map((tenant: Tenant) => (
                    <div
                      key={tenant.id}
                      className="flex items-center justify-between"
                    >
                      <div>
                        <Link
                          href={`/admin/apps/mark8ly/${tenant.id}`}
                          className="font-medium hover:underline"
                        >
                          {tenant.name}
                        </Link>
                        <p className="text-sm text-muted-foreground">
                          {tenant.slug}
                        </p>
                      </div>
                      {tenant.status && (
                        <Badge variant={getStatusColor(tenant.status)}>
                          {tenant.status}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Audit Events */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Audit Events</CardTitle>
                <CardDescription>Latest system activity</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/admin/audit-logs">
                  View all
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {auditLoading ? (
                <RecentListSkeleton />
              ) : auditError ? (
                <ErrorState message={auditError} onRetry={mutateAudit} />
              ) : recentAuditLogs.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No audit events yet
                </p>
              ) : (
                <div className="space-y-4">
                  {recentAuditLogs.slice(0, 5).map((log: AuditLog) => (
                    <div
                      key={log.id}
                      className="flex items-center justify-between gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">
                          {log.action}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {log.actor} &middot;{" "}
                          {new Date(log.timestamp).toLocaleString()}
                        </p>
                      </div>
                      <Badge variant={severityColor(log.severity)}>
                        {log.severity}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  );
}
