"use client";

import {
  Database,
  GitBranch,
  Package,
  Radio,
  HardDrive,
  Shield,
  Key,
  ArrowRight,
  ArrowLeft,
  ExternalLink,
} from "lucide-react";
import {
  getServiceDependencies,
  getServiceDependents,
  type ServiceConfig,
} from "@/lib/releases/services";
import type { ServiceInfo } from "@/lib/api/releases";
import { StatusBadge } from "./status-badge";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@tesserix/web";

interface ServiceDetailSheetProps {
  service: ServiceConfig | null;
  serviceInfo?: ServiceInfo | null;
  onClose: () => void;
  onServiceClick?: (serviceName: string) => void;
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="text-sm text-right">{children}</div>
    </div>
  );
}

function DependencyChip({
  name,
  direction,
  onClick,
}: {
  name: string;
  direction: "outbound" | "inbound";
  onClick?: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-7 gap-1.5 text-xs font-mono"
    >
      {direction === "outbound" ? (
        <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      ) : (
        <ArrowLeft className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      )}
      {name}
    </Button>
  );
}

export function ServiceDetailSheet({
  service,
  serviceInfo,
  onClose,
  onServiceClick,
}: ServiceDetailSheetProps) {
  if (!service) return null;

  const dependencies = getServiceDependencies(service.name);
  const dependents = getServiceDependents(service.name);

  return (
    <Sheet open={!!service} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-[720px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            {service.displayName}
            <a
              href={`https://github.com/${service.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {service.name}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 mt-6">
          {/* Badges */}
          <div className="flex flex-wrap gap-2">
            <Badge
              variant="secondary"
              className={
                service.lang === "go"
                  ? "bg-muted text-muted-foreground"
                  : "bg-info/15 text-info"
              }
            >
              {service.lang === "go" ? "Go" : "Next.js"}
            </Badge>
            <Badge variant="outline">{service.type}</Badge>
            <Badge variant="secondary">{service.appGroup}</Badge>
            {!service.managed && (
              <Badge className="bg-warning/10 text-warning border-warning/20 gap-1">
                <Shield className="h-3 w-3" aria-hidden="true" />
                External Image
              </Badge>
            )}
          </div>

          {/* Live status cards */}
          {serviceInfo && (
            <div className="grid gap-3 grid-cols-2">
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground mb-1">
                    Latest Build
                  </p>
                  {serviceInfo.latestBuild ? (
                    <div className="space-y-1">
                      <StatusBadge status={serviceInfo.latestBuild.status} />
                      <p className="text-xs text-muted-foreground font-mono">
                        {serviceInfo.latestBuild.tag}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">-</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground mb-1">
                    Latest Release
                  </p>
                  {serviceInfo.latestRelease ? (
                    <div className="space-y-1">
                      <Badge variant="outline" className="font-mono text-xs">
                        v{serviceInfo.latestRelease.version}
                      </Badge>
                      {serviceInfo.latestRelease.status !== "none" && (
                        <StatusBadge
                          status={serviceInfo.latestRelease.status}
                        />
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">-</p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Infrastructure */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Infrastructure</h3>
            <Card>
              <CardContent className="p-4 divide-y divide-border">
                <InfoRow label="Database">
                  {service.hasDb ? (
                    <div className="flex items-center gap-1.5">
                      <Database className="h-3.5 w-3.5 text-info" aria-hidden="true" />
                      <span>Yes</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </InfoRow>
                {service.hasDb && (
                  <InfoRow label="Migration">
                    <Badge variant="secondary" className="text-xs">
                      {service.migration}
                    </Badge>
                  </InfoRow>
                )}
                <InfoRow label="Sidecar">
                  {service.sidecar === "cloud-sql-proxy" ? (
                    <div className="flex items-center gap-1.5">
                      <HardDrive className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      <span>Cloud SQL Proxy</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </InfoRow>
                <InfoRow label="go-shared">
                  {service.usesGoShared ? (
                    <div className="flex items-center gap-1.5">
                      <Package className="h-3.5 w-3.5 text-chart-5" aria-hidden="true" />
                      <span>Consumer</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">No</span>
                  )}
                </InfoRow>
                {service.publishesEvents && (
                  <InfoRow label="Pub/Sub Topic">
                    <div className="flex items-center gap-1.5">
                      <Radio className="h-3.5 w-3.5 text-chart-2" aria-hidden="true" />
                      <span className="font-mono text-xs">
                        {service.pubsubTopic}
                      </span>
                    </div>
                  </InfoRow>
                )}
                {service.storageApps.length > 0 && (
                  <InfoRow label="Storage">
                    <div className="flex gap-1">
                      {service.storageApps.map((app) => (
                        <Badge key={app} variant="secondary" className="text-xs">
                          {app}
                        </Badge>
                      ))}
                    </div>
                  </InfoRow>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Secrets */}
          {service.secrets.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                Secrets ({service.secrets.length})
              </h3>
              <Card>
                <CardContent className="p-4">
                  <div className="flex flex-wrap gap-2">
                    {service.secrets.map((secret) => (
                      <Badge
                        key={secret}
                        variant="outline"
                        className="font-mono text-xs"
                      >
                        {secret}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Dependencies */}
          {(dependencies.length > 0 || dependents.length > 0) && (
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                Dependencies
              </h3>
              <Card>
                <CardContent className="p-4 space-y-4">
                  {dependencies.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">
                        This service calls:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {dependencies.map((dep) => (
                          <DependencyChip
                            key={dep.name}
                            name={dep.name}
                            direction="outbound"
                            onClick={() => onServiceClick?.(dep.name)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {dependencies.length > 0 && dependents.length > 0 && (
                    <Separator />
                  )}

                  {dependents.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">
                        Called by:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {dependents.map((dep) => (
                          <DependencyChip
                            key={dep.name}
                            name={dep.name}
                            direction="inbound"
                            onClick={() => onServiceClick?.(dep.name)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Repository link */}
          <div>
            <a
              href={`https://github.com/${service.repo}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" className="w-full gap-2">
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                View on GitHub
              </Button>
            </a>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
