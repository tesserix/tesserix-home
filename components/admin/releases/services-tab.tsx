"use client";

import { useState, useMemo } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Rocket,
  Search,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "./status-badge";
import { VersionChips } from "./version-chips";
import { promoteService, promoteGroup, type ServiceInfo, type BuildStatus } from "@/lib/api/releases";
import type { ServiceType, AppGroup } from "@/lib/releases/services";

type TypeFilter = "all" | ServiceType;

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "backend", label: "Backend" },
  { value: "frontend", label: "Frontend" },
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

interface RepoGroup {
  repo: string;
  repoShort: string;
  appGroup: AppGroup | null;
  services: ServiceInfo[];
}

function resolveAppGroup(repoShort: string): AppGroup | null {
  if (repoShort === "marketplace-services" || repoShort === "marketplace-clients")
    return "mark8ly";
  if (repoShort === "global-services") return "global";
  return null;
}

function groupByRepo(services: ServiceInfo[]): RepoGroup[] {
  const map = new Map<string, ServiceInfo[]>();
  for (const svc of services) {
    const key = svc.repo || "unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(svc);
  }
  return Array.from(map.entries()).map(([repo, svcs]) => {
    const repoShort = repo.split("/").pop() ?? repo;
    return {
      repo,
      repoShort,
      appGroup: resolveAppGroup(repoShort),
      services: svcs,
    };
  });
}

function repoGroupStatus(services: ServiceInfo[]): BuildStatus {
  if (services.some((s) => s.latestBuild?.status === "failure")) return "failure";
  if (services.some((s) => s.latestBuild?.status === "in_progress")) return "in_progress";
  if (services.every((s) => s.latestBuild?.status === "success")) return "success";
  return "none";
}

function bumpPatch(version: string): string {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "";
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function InlinePromote({
  service,
  onClose,
  onSuccess,
}: {
  service: ServiceInfo;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const currentVersion = service.latestRelease?.version ?? null;
  const defaultVersion =
    currentVersion && /^\d+\.\d+\.\d+$/.test(currentVersion)
      ? bumpPatch(currentVersion)
      : "";

  const [version, setVersion] = useState(defaultVersion);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{
    version: string;
    repo: string;
  } | null>(null);

  const handleSubmit = async () => {
    if (!version) return;
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      setError("Version must be in semver format (e.g. 1.2.3)");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    const result = await promoteService(service.name, version);
    setIsSubmitting(false);
    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setSuccessInfo({ version: result.data.version, repo: result.data.repo });
      onSuccess();
    }
  };

  if (successInfo) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3 mt-2">
        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
        <p className="text-sm">
          Release <span className="font-mono font-medium">v{successInfo.version}</span> triggered
        </p>
        <a
          href={`https://github.com/${successInfo.repo}/actions`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline ml-auto"
        >
          View in Actions
          <ExternalLink className="h-3 w-3" />
        </a>
        <Button variant="ghost" size="sm" onClick={onClose} className="shrink-0 h-7 w-7 p-0">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-3 mt-2 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Current:</span>
          {currentVersion ? (
            <Badge variant="outline" className="font-mono text-xs">
              v{currentVersion}
            </Badge>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Input
          placeholder="1.2.3"
          value={version}
          onChange={(e) => {
            setVersion(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") onClose();
          }}
          className="font-mono h-8 max-w-[160px]"
          autoFocus
        />
        <Button size="sm" onClick={handleSubmit} disabled={!version || isSubmitting} className="h-8">
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
          ) : (
            <Rocket className="h-3.5 w-3.5 mr-1" />
          )}
          Promote
        </Button>
      </div>

      <VersionChips currentVersion={currentVersion} onSelect={setVersion} />

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ServiceRow({
  service,
  promoteOpen,
  onTogglePromote,
  onPromoteSuccess,
}: {
  service: ServiceInfo;
  promoteOpen: boolean;
  onTogglePromote: () => void;
  onPromoteSuccess: () => void;
}) {
  const canPromote = !!service.repo;
  return (
    <div>
      <div className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm truncate">{service.displayName}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant="secondary" className="text-xs">
                {service.type}
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          {/* Build status */}
          <div className="text-right hidden sm:block min-w-[120px]">
            {service.latestBuild ? (
              <div className="space-y-0.5">
                <StatusBadge status={service.latestBuild.status} />
                <p className="text-xs text-muted-foreground truncate">
                  {service.latestBuild.tag}
                </p>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">-</span>
            )}
          </div>

          {/* Release version */}
          <div className="text-right hidden md:block min-w-[100px]">
            {service.latestRelease ? (
              <div className="space-y-0.5">
                <Badge variant="outline" className="font-mono text-xs">
                  v{service.latestRelease.version}
                </Badge>
                {service.latestRelease.status !== "none" && (
                  <StatusBadge status={service.latestRelease.status} />
                )}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">-</span>
            )}
          </div>

          {/* Promote toggle */}
          <Button
            variant={promoteOpen ? "default" : "outline"}
            size="sm"
            disabled={!canPromote}
            onClick={onTogglePromote}
            className="shrink-0"
          >
            <Rocket className="h-3.5 w-3.5 mr-1" />
            Promote
          </Button>
        </div>
      </div>

      {/* Inline promote panel */}
      {promoteOpen && (
        <InlinePromote
          service={service}
          onClose={onTogglePromote}
          onSuccess={onPromoteSuccess}
        />
      )}
    </div>
  );
}

function InlineGroupPromote({
  appGroup,
  groupLabel,
  serviceCount,
  onClose,
  onSuccess,
}: {
  appGroup: AppGroup;
  groupLabel: string;
  serviceCount: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [version, setVersion] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    succeeded: string[];
    failed: string[];
  } | null>(null);

  const handleSubmit = async () => {
    if (!version) return;
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      setError("Version must be in semver format (e.g. 1.2.3)");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    const res = await promoteGroup(appGroup, version);
    setIsSubmitting(false);
    if (res.error) {
      setError(res.error);
    } else if (res.data) {
      setResult({ succeeded: res.data.succeeded, failed: res.data.failed });
      onSuccess();
    }
  };

  if (result) {
    return (
      <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 mx-4 mb-4 space-y-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <p className="text-sm font-medium">
              Tagged {result.succeeded.length}/{result.succeeded.length + result.failed.length} services with v{version}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {result.failed.length > 0 && (
          <p className="text-xs text-destructive">
            Failed: {result.failed.join(", ")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-3 mx-4 mb-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          Tag all {serviceCount} {groupLabel} services
        </p>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          placeholder="1.2.3"
          value={version}
          onChange={(e) => {
            setVersion(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") onClose();
          }}
          className="font-mono h-8 max-w-[160px]"
          autoFocus
        />
        <Button size="sm" onClick={handleSubmit} disabled={!version || isSubmitting} className="h-8">
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
          ) : (
            <Rocket className="h-3.5 w-3.5 mr-1" />
          )}
          Tag All
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function RepoGroupSection({
  group,
  activePromote,
  onTogglePromote,
  onPromoteSuccess,
  defaultExpanded,
}: {
  group: RepoGroup;
  activePromote: string | null;
  onTogglePromote: (serviceName: string) => void;
  onPromoteSuccess: () => void;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [groupPromoteOpen, setGroupPromoteOpen] = useState(false);
  const status = repoGroupStatus(group.services);
  const failed = group.services.filter(
    (s) => s.latestBuild?.status === "failure"
  ).length;
  const isMark8ly = group.appGroup === "mark8ly";

  return (
    <Card>
      <div className="flex items-center justify-between p-4">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <h4 className="text-sm font-semibold">{group.repoShort}</h4>
          <span className="text-xs text-muted-foreground">
            {group.services.length} services
          </span>
        </button>
        <div className="flex items-center gap-2">
          {failed > 0 && (
            <Badge variant="destructive">{failed} failed</Badge>
          )}
          {status === "success" && (
            <Badge variant="success">All passing</Badge>
          )}
          {status === "in_progress" && (
            <Badge variant="warning">Building</Badge>
          )}
          {isMark8ly && (
            <Button
              variant={groupPromoteOpen ? "default" : "outline"}
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setGroupPromoteOpen(!groupPromoteOpen);
              }}
              className="h-7 text-xs"
            >
              <Rocket className="h-3 w-3 mr-1" />
              Tag All
            </Button>
          )}
        </div>
      </div>

      {/* Group promote panel */}
      {groupPromoteOpen && group.appGroup && (
        <InlineGroupPromote
          appGroup={group.appGroup}
          groupLabel={group.repoShort}
          serviceCount={group.services.length}
          onClose={() => setGroupPromoteOpen(false)}
          onSuccess={onPromoteSuccess}
        />
      )}

      {expanded && (
        <CardContent className="pt-0 pb-4 px-4">
          <div className="space-y-2">
            {group.services.map((svc) => (
              <ServiceRow
                key={svc.name}
                service={svc}
                promoteOpen={activePromote === svc.name}
                onTogglePromote={() => onTogglePromote(svc.name)}
                onPromoteSuccess={onPromoteSuccess}
              />
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export function ServicesTabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-20 rounded-full" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-40" />
      ))}
    </div>
  );
}

export function ServicesTab({
  services,
  onPromoteSuccess,
}: {
  services: ServiceInfo[];
  onPromoteSuccess: () => void;
}) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");
  const [activePromote, setActivePromote] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = services;
    if (typeFilter !== "all") {
      result = result.filter((s) => s.type === typeFilter);
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
  }, [services, typeFilter, search]);

  const groups = useMemo(() => groupByRepo(filtered), [filtered]);

  const failedBuilds = services.filter(
    (s) => s.latestBuild?.status === "failure"
  ).length;
  const inProgress = services.filter(
    (s) => s.latestBuild?.status === "in_progress"
  ).length;
  const successBuilds = services.filter(
    (s) => s.latestBuild?.status === "success"
  ).length;

  const typeCounts: Record<TypeFilter, number> = {
    all: services.length,
    backend: services.filter((s) => s.type === "backend").length,
    frontend: services.filter((s) => s.type === "frontend").length,
  };

  const handleTogglePromote = (serviceName: string) => {
    setActivePromote((prev) => (prev === serviceName ? null : serviceName));
  };

  return (
    <div className="space-y-4">
      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{successBuilds}</p>
                <p className="text-xs text-muted-foreground">Passing Builds</p>
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
                <p className="text-2xl font-bold">{failedBuilds}</p>
                <p className="text-xs text-muted-foreground">Failed Builds</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
                <Loader2 className="h-5 w-5 text-yellow-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{inProgress}</p>
                <p className="text-xs text-muted-foreground">In Progress</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {TYPE_FILTERS.map((f) => (
            <FilterChip
              key={f.value}
              label={f.label}
              active={typeFilter === f.value}
              count={typeCounts[f.value]}
              onClick={() => setTypeFilter(f.value)}
            />
          ))}
        </div>
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

      {/* Service groups */}
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
                setTypeFilter("all");
                setSearch("");
              }}
            >
              Clear filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <RepoGroupSection
            key={group.repo}
            group={group}
            activePromote={activePromote}
            onTogglePromote={handleTogglePromote}
            onPromoteSuccess={onPromoteSuccess}
            defaultExpanded={groups.length <= 4}
          />
        ))
      )}
    </div>
  );
}
