"use client";

import { useState, useMemo } from "react";
import {
  Search,
  Database,
  GitBranch,
  Package,
  Radio,
  ChevronDown,
  ChevronRight,
  Shield,
  HardDrive,
  ExternalLink,
  Plus,
} from "lucide-react";
import {
  SERVICE_REGISTRY,
  getServiceDependents,
  type ServiceConfig,
  type AppGroup,
  type ServiceLang,
} from "@/lib/releases/services";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Skeleton,
  Separator,
} from "@tesserix/web";
import { ServiceDetailSheet } from "./service-detail-sheet";
import { AddServiceWizard } from "./add-service-wizard";

type AppFilter = "all" | AppGroup;
type LangFilter = "all" | ServiceLang;

const APP_FILTERS: { value: AppFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "platform", label: "Platform" },
  { value: "mark8ly", label: "Marketplace" },
];

const LANG_FILTERS: { value: LangFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "go", label: "Go" },
  { value: "nextjs", label: "Next.js" },
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
    <Button
      onClick={onClick}
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-8 gap-1.5 rounded-full"
    >
      {label}
      {count !== undefined && (
        <Badge
          variant={active ? "secondary" : "outline"}
          className="h-5 min-w-5 rounded-full px-1 text-[10px]"
        >
          {count}
        </Badge>
      )}
    </Button>
  );
}

function ServiceBadges({ service }: { service: ServiceConfig }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge
        variant="secondary"
        className={
          service.lang === "go"
            ? "bg-zinc-600/20 text-muted-foreground text-xs"
            : "bg-info/15 text-info text-xs"
        }
      >
        {service.lang === "go" ? "Go" : "Next.js"}
      </Badge>
      <Badge variant="outline" className="text-xs">
        {service.type}
      </Badge>
      {service.hasDb && (
        <Badge className="bg-info/10 text-info border-info/20 text-xs gap-1">
          <Database className="h-3 w-3" />
          DB
        </Badge>
      )}
      {service.usesGoShared && (
        <Badge className="bg-muted text-foreground/70 border-foreground/20 text-xs gap-1">
          <Package className="h-3 w-3" />
          GS
        </Badge>
      )}
      {service.publishesEvents && (
        <Badge className="bg-muted text-foreground/70 border-foreground/20 text-xs gap-1">
          <Radio className="h-3 w-3" />
          Events
        </Badge>
      )}
      {service.sidecar === "cloud-sql-proxy" && (
        <Badge className="bg-slate-500/10 text-slate-400 border-slate-500/20 text-xs gap-1">
          <HardDrive className="h-3 w-3" />
          Proxy
        </Badge>
      )}
      {!service.managed && (
        <Badge className="bg-warning/10 text-warning border-warning/20 text-xs gap-1">
          <Shield className="h-3 w-3" />
          External
        </Badge>
      )}
    </div>
  );
}

function ServiceCard({
  service,
  onClick,
}: {
  service: ServiceConfig;
  onClick: () => void;
}) {
  const dependents = getServiceDependents(service.name);

  return (
    <Card
      className="cursor-pointer hover:border-primary/30 transition-colors"
      onClick={onClick}
    >
      <CardContent className="p-4 space-y-3">
        <div>
          <p className="font-medium text-sm">{service.displayName}</p>
          <p className="text-xs text-muted-foreground font-mono">
            {service.name}
          </p>
        </div>

        <ServiceBadges service={service} />

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {service.invokes.length > 0 && (
            <span className="flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              Calls {service.invokes.length}
            </span>
          )}
          {dependents.length > 0 && (
            <span>Called by {dependents.length}</span>
          )}
          {service.secrets.length > 0 && (
            <span>{service.secrets.length} secrets</span>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs w-full justify-start gap-1 px-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          View Details
          <ExternalLink className="h-3 w-3" />
        </Button>
      </CardContent>
    </Card>
  );
}

const APP_GROUP_LABELS: Record<AppGroup, string> = {
  platform: "Platform Services",
  mark8ly: "Marketplace (mark8ly)",
};

function ServiceGroup({
  appGroup,
  services,
  onServiceClick,
  defaultExpanded,
}: {
  appGroup: AppGroup;
  services: ServiceConfig[];
  onServiceClick: (name: string) => void;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        className="h-auto items-center gap-3 p-2 text-left hover:opacity-80 mb-2"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <h4 className="text-sm font-semibold">
          {APP_GROUP_LABELS[appGroup]}
        </h4>
        <span className="text-xs text-muted-foreground">
          {services.length} services
        </span>
      </Button>

      {expanded && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {services.map((svc) => (
            <ServiceCard
              key={svc.name}
              service={svc}
              onClick={() => onServiceClick(svc.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function RegistryTabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-20 rounded-full" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
    </div>
  );
}

export function RegistryTab() {
  const [appFilter, setAppFilter] = useState<AppFilter>("all");
  const [langFilter, setLangFilter] = useState<LangFilter>("all");
  const [dbOnly, setDbOnly] = useState(false);
  const [goSharedOnly, setGoSharedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [addWizardOpen, setAddWizardOpen] = useState(false);

  const filtered = useMemo(() => {
    let result = SERVICE_REGISTRY;
    if (appFilter !== "all") {
      result = result.filter((s) => s.appGroup === appFilter);
    }
    if (langFilter !== "all") {
      result = result.filter((s) => s.lang === langFilter);
    }
    if (dbOnly) {
      result = result.filter((s) => s.hasDb);
    }
    if (goSharedOnly) {
      result = result.filter((s) => s.usesGoShared);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.displayName.toLowerCase().includes(q)
      );
    }
    return result;
  }, [appFilter, langFilter, dbOnly, goSharedOnly, search]);

  const grouped = useMemo(() => {
    const map = new Map<AppGroup, ServiceConfig[]>();
    for (const svc of filtered) {
      if (!map.has(svc.appGroup)) map.set(svc.appGroup, []);
      map.get(svc.appGroup)!.push(svc);
    }
    return map;
  }, [filtered]);

  const selectedConfig = selectedService
    ? SERVICE_REGISTRY.find((s) => s.name === selectedService) ?? null
    : null;

  const counts = {
    all: SERVICE_REGISTRY.length,
    platform: SERVICE_REGISTRY.filter((s) => s.appGroup === "platform").length,
    mark8ly: SERVICE_REGISTRY.filter((s) => s.appGroup === "mark8ly").length,
  };

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div />
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => setAddWizardOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Add Service
        </Button>
      </div>

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{SERVICE_REGISTRY.length}</p>
            <p className="text-xs text-muted-foreground">Total Services</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">
              {SERVICE_REGISTRY.filter((s) => s.lang === "go").length}
            </p>
            <p className="text-xs text-muted-foreground">Go Services</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">
              {SERVICE_REGISTRY.filter((s) => s.hasDb).length}
            </p>
            <p className="text-xs text-muted-foreground">With Database</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">
              {SERVICE_REGISTRY.filter((s) => s.usesGoShared).length}
            </p>
            <p className="text-xs text-muted-foreground">go-shared Consumers</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {APP_FILTERS.map((f) => (
            <FilterChip
              key={f.value}
              label={f.label}
              active={appFilter === f.value}
              count={counts[f.value]}
              onClick={() => setAppFilter(f.value)}
            />
          ))}
        </div>

        <Separator orientation="vertical" className="h-6" />

        <div className="flex flex-wrap gap-2">
          {LANG_FILTERS.map((f) => (
            <FilterChip
              key={f.value}
              label={f.label}
              active={langFilter === f.value}
              onClick={() => setLangFilter(f.value)}
            />
          ))}
        </div>

        <Separator orientation="vertical" className="h-6" />

        <FilterChip
          label="Has DB"
          active={dbOnly}
          onClick={() => setDbOnly(!dbOnly)}
        />
        <FilterChip
          label="go-shared"
          active={goSharedOnly}
          onClick={() => setGoSharedOnly(!goSharedOnly)}
        />

        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search services..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
      </div>

      {/* Service Groups */}
      {filtered.length === 0 ? (
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
                setAppFilter("all");
                setLangFilter("all");
                setDbOnly(false);
                setGoSharedOnly(false);
                setSearch("");
              }}
            >
              Clear filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {(["platform", "mark8ly"] as AppGroup[]).map((group) => {
            const services = grouped.get(group);
            if (!services?.length) return null;
            return (
              <ServiceGroup
                key={group}
                appGroup={group}
                services={services}
                onServiceClick={setSelectedService}
                defaultExpanded
              />
            );
          })}
        </div>
      )}

      {/* Service Detail Sheet */}
      <ServiceDetailSheet
        service={selectedConfig}
        onClose={() => setSelectedService(null)}
        onServiceClick={setSelectedService}
      />

      {/* Add Service Wizard */}
      <AddServiceWizard
        open={addWizardOpen}
        onOpenChange={setAddWizardOpen}
        onSuccess={() => {
          // The registry is static (SERVICE_REGISTRY is compile-time), so
          // just close the wizard. The PR must be merged and the registry
          // updated for the new service to appear.
        }}
      />
    </div>
  );
}
