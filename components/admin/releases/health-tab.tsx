"use client";

import {
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  RefreshCw,
  ExternalLink,
  Server,
} from "lucide-react";
import {
  useServiceHealth,
  type HealthStatus,
  type ServiceHealth,
} from "@/lib/api/releases";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@tesserix/web";

const STATUS_CONFIG: Record<
  HealthStatus,
  { icon: typeof CheckCircle2; color: string; bg: string; label: string }
> = {
  healthy: {
    icon: CheckCircle2,
    color: "text-success",
    bg: "bg-success/10",
    label: "Healthy",
  },
  degraded: {
    icon: AlertTriangle,
    color: "text-error",
    bg: "bg-error/10",
    label: "Degraded",
  },
  unknown: {
    icon: HelpCircle,
    color: "text-muted-foreground",
    bg: "bg-zinc-500/10",
    label: "Unknown",
  },
};

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function extractVersion(image: string): string {
  const match = image.match(/:(.+)$/);
  return match ? match[1] : "-";
}

function HealthStatusBadge({ status }: { status: HealthStatus }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <Badge className={`${config.bg} ${config.color} border-0 gap-1`}>
      <Icon  className="h-3 w-3" aria-hidden="true" />
      {config.label}
    </Badge>
  );
}

function HealthRow({ service }: { service: ServiceHealth }) {
  return (
    <TableRow>
      <TableCell>
        <div>
          <p className="font-medium text-sm">{service.displayName}</p>
          <p className="text-xs text-muted-foreground font-mono">
            {service.name}
          </p>
        </div>
      </TableCell>
      <TableCell>
        <HealthStatusBadge status={service.status} />
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="font-mono text-xs">
          {extractVersion(service.latestImage)}
        </Badge>
      </TableCell>
      <TableCell>
        <span className="text-sm">
          {service.instanceCount}/{service.maxInstances}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-xs text-muted-foreground">
          {relativeTime(service.lastDeployedAt)}
        </span>
      </TableCell>
      <TableCell>
        {service.latestRevision && (
          <span className="text-xs text-muted-foreground font-mono truncate block max-w-[180px]">
            {service.latestRevision}
          </span>
        )}
      </TableCell>
      <TableCell>
        {service.url && (
          <a
            href={service.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            URL
            <ExternalLink  className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </TableCell>
    </TableRow>
  );
}

export function HealthTabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-96" />
    </div>
  );
}

export function HealthTab() {
  const { data, isLoading, error, mutate } = useServiceHealth();

  if (isLoading) return <HealthTabSkeleton />;

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">{error}</p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={mutate}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const services = data?.data ?? [];
  const healthy = services.filter((s) => s.status === "healthy").length;
  const degraded = services.filter((s) => s.status === "degraded").length;
  const unknown = services.filter((s) => s.status === "unknown").length;

  return (
    <div className="space-y-4">
      {/* Not available notice */}
      {data && !data.available && (
        <Card>
          <CardContent className="p-4 flex items-center gap-3 border-warning/30 bg-warning/5">
            <AlertTriangle  className="h-4 w-4 text-warning shrink-0" aria-hidden="true" />
            <p className="text-sm text-warning">
              Health data unavailable — not running on Cloud Run. Status shown
              as &quot;Unknown&quot; for all services.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="flex items-center justify-between">
        <div className="grid gap-4 sm:grid-cols-3 flex-1">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
                  <CheckCircle2  className="h-5 w-5 text-success" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{healthy}</p>
                  <p className="text-xs text-muted-foreground">Healthy</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-error/10">
                  <AlertTriangle  className="h-5 w-5 text-error" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{degraded}</p>
                  <p className="text-xs text-muted-foreground">Degraded</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-500/10">
                  <HelpCircle  className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{unknown}</p>
                  <p className="text-xs text-muted-foreground">Unknown</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        <Button variant="outline" size="sm" onClick={mutate} className="ml-4">
          <RefreshCw  className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {/* Health Table */}
      {services.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <Server  className="h-8 w-8 text-muted-foreground mx-auto" aria-hidden="true" />
            <p className="text-muted-foreground">No services found.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Instances</TableHead>
                  <TableHead>Deployed</TableHead>
                  <TableHead>Revision</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {services.map((svc) => (
                  <HealthRow key={svc.name} service={svc} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
