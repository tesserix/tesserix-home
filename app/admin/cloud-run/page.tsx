"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Server,
  Search,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Tag,
  Layers,
  Activity,
  Clock,
  Lock,
  Globe,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ScrollArea,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@tesserix/web";
import { apiFetch } from "@/lib/api/use-api";
import { SERVICE_REGISTRY, type AppGroup } from "@/lib/releases/services";

// ─── Types ───

interface CloudRunService {
  name: string;
  displayName: string;
  generation: number;
  creator: string;
  createTime: string;
  updateTime: string;
  uri: string;
  latestReadyRevision: string;
  servingStatus: "Serving" | "Deploying" | "Failed" | "Unknown";
  routingStatus: "Active" | "Inactive" | "Unknown";
  conditions: Array<{ type: string; state: string; message?: string }>;
  minScale: number;
  maxScale: number;
  image: string;
  imageTag: string;
  envVarCount: number;
}

interface RevisionSummary {
  name: string;
  createTime: string;
  image: string;
  imageTag: string;
  minScale: number;
  maxScale: number;
  readyState: string;
  trafficPercent: number;
  isLatestReady: boolean;
  conditions: Array<{ type: string; state: string; message?: string }>;
}

interface ServiceDetail {
  name: string;
  uri: string;
  latestReadyRevision: string;
  revisions: RevisionSummary[];
}

interface EnvDetail {
  serviceName: string;
  envVarNames: string[];
  count: number;
}

// ─── Helpers ───

const APP_GROUP_LABELS: Record<"all" | AppGroup, string> = {
  all: "All",
  platform: "Platform",
  mark8ly: "Mark8ly",
};

function getAppGroupForService(name: string): AppGroup {
  const svc = SERVICE_REGISTRY.find((s) => s.name === name);
  return svc?.appGroup ?? "platform";
}

function relativeTime(iso: string): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function shortImage(image: string): string {
  // Show only the last path segment + tag
  const withoutProto = image.replace(/^https?:\/\//, "");
  const parts = withoutProto.split("/");
  const last = parts[parts.length - 1] ?? image;
  // Shorten long sha256 tags
  const colonIdx = last.indexOf(":");
  if (colonIdx !== -1) {
    const tag = last.slice(colonIdx + 1);
    if (tag.startsWith("sha256-") && tag.length > 20) {
      return `${last.slice(0, colonIdx + 1)}${tag.slice(0, 19)}`;
    }
  }
  return last;
}

// ─── Sub-components ───

function AppGroupFilter({
  value,
  onChange,
}: {
  value: "all" | AppGroup;
  onChange: (v: "all" | AppGroup) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border p-0.5">
      {(Object.keys(APP_GROUP_LABELS) as Array<"all" | AppGroup>).map((key) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === key
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {APP_GROUP_LABELS[key]}
        </button>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: CloudRunService["servingStatus"] }) {
  if (status === "Serving") {
    return (
      <Badge className="bg-green-500/15 text-green-600 border-green-500/20 hover:bg-green-500/20 gap-1 font-medium">
        <CheckCircle2 className="h-3 w-3" />
        Serving
      </Badge>
    );
  }
  if (status === "Deploying") {
    return (
      <Badge className="bg-yellow-500/15 text-yellow-600 border-yellow-500/20 hover:bg-yellow-500/20 gap-1 font-medium">
        <Loader2 className="h-3 w-3 animate-spin" />
        Deploying
      </Badge>
    );
  }
  if (status === "Failed") {
    return (
      <Badge className="bg-red-500/15 text-red-600 border-red-500/20 hover:bg-red-500/20 gap-1 font-medium">
        <AlertCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 font-medium">
      <Activity className="h-3 w-3" />
      Unknown
    </Badge>
  );
}

function RevisionReadyBadge({ state }: { state: string }) {
  if (state === "Ready") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600">
        <CheckCircle2 className="h-3 w-3" />
        Ready
      </span>
    );
  }
  if (state === "Failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-600">
        <AlertCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-yellow-600">
      <Loader2 className="h-3 w-3 animate-spin" />
      {state}
    </span>
  );
}

// ─── Service Detail Panel ───

function ServiceDetailPanel({ serviceName }: { serviceName: string }) {
  const [detail, setDetail] = useState<ServiceDetail | null>(null);
  const [envDetail, setEnvDetail] = useState<EnvDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [loadingEnv, setLoadingEnv] = useState(true);

  useEffect(() => {
    setLoadingDetail(true);
    setLoadingEnv(true);
    setDetail(null);
    setEnvDetail(null);

    apiFetch<{ data: ServiceDetail }>(`/api/cloud-run/${serviceName}`).then(
      (res) => {
        if (res.data?.data) setDetail(res.data.data);
        setLoadingDetail(false);
      }
    );

    apiFetch<{ data: EnvDetail }>(`/api/cloud-run/${serviceName}/env`).then(
      (res) => {
        if (res.data?.data) setEnvDetail(res.data.data);
        setLoadingEnv(false);
      }
    );
  }, [serviceName]);

  if (loadingDetail) {
    return (
      <div className="space-y-3 pt-2">
        <Skeleton className="h-5 w-32" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <p className="text-sm text-muted-foreground pt-2">
        Failed to load service details.
      </p>
    );
  }

  return (
    <div className="space-y-5 pt-1">
      {/* Revisions */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5" />
          Revisions (latest 20)
        </h4>
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="text-xs h-8">Revision</TableHead>
                <TableHead className="text-xs h-8">Image Tag</TableHead>
                <TableHead className="text-xs h-8">State</TableHead>
                <TableHead className="text-xs h-8">Traffic</TableHead>
                <TableHead className="text-xs h-8">Scale</TableHead>
                <TableHead className="text-xs h-8">Deployed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.revisions.map((rev) => (
                <TableRow
                  key={rev.name}
                  className={rev.isLatestReady ? "bg-green-500/5" : ""}
                >
                  <TableCell className="font-mono text-xs py-2">
                    <div className="flex items-center gap-1.5">
                      {rev.isLatestReady && (
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
                      )}
                      <span className="truncate max-w-[180px]">{rev.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs py-2 text-muted-foreground">
                    {rev.imageTag}
                  </TableCell>
                  <TableCell className="py-2">
                    <RevisionReadyBadge state={rev.readyState} />
                  </TableCell>
                  <TableCell className="text-xs py-2">
                    {rev.trafficPercent > 0 ? (
                      <span className="font-medium text-primary">
                        {rev.trafficPercent}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs py-2 text-muted-foreground">
                    {rev.minScale}–{rev.maxScale}
                  </TableCell>
                  <TableCell className="text-xs py-2 text-muted-foreground">
                    {relativeTime(rev.createTime)}
                  </TableCell>
                </TableRow>
              ))}
              {detail.revisions.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-xs text-muted-foreground py-4"
                  >
                    No revisions found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Env Vars */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5" />
          Environment Variables
          {!loadingEnv && envDetail && (
            <span className="ml-1 text-xs font-normal normal-case">
              ({envDetail.count} configured)
            </span>
          )}
        </h4>
        {loadingEnv ? (
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-28 rounded-md" />
            ))}
          </div>
        ) : envDetail && envDetail.envVarNames.length > 0 ? (
          <ScrollArea className="max-h-32">
            <div className="flex flex-wrap gap-1.5">
              {envDetail.envVarNames.map((name) => (
                <code
                  key={name}
                  className="rounded bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground"
                >
                  {name}
                </code>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <p className="text-xs text-muted-foreground">No env vars configured</p>
        )}
      </div>
    </div>
  );
}

// ─── Summary Cards ───

function SummaryCards({
  services,
  loading,
}: {
  services: CloudRunService[];
  loading: boolean;
}) {
  const total = services.length;
  const serving = services.filter((s) => s.servingStatus === "Serving").length;
  const failed = services.filter((s) => s.servingStatus === "Failed").length;
  const deploying = services.filter((s) => s.servingStatus === "Deploying").length;

  const lastDeployed = useMemo(() => {
    if (services.length === 0) return null;
    const sorted = [...services].sort(
      (a, b) => new Date(b.updateTime).getTime() - new Date(a.updateTime).getTime()
    );
    return sorted[0];
  }, [services]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Server className="h-4 w-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground font-medium">Total Services</p>
          </div>
          <p className="text-2xl font-bold">{total}</p>
          <p className="text-xs text-muted-foreground mt-0.5">on Cloud Run</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <p className="text-xs text-muted-foreground font-medium">Serving</p>
          </div>
          <p className="text-2xl font-bold text-green-600">{serving}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {total > 0 ? `${Math.round((serving / total) * 100)}% healthy` : "—"}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle
              className={`h-4 w-4 ${failed > 0 ? "text-red-500" : "text-muted-foreground"}`}
            />
            <p className="text-xs text-muted-foreground font-medium">Issues</p>
          </div>
          <p className={`text-2xl font-bold ${failed > 0 ? "text-red-600" : ""}`}>
            {failed + deploying}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {failed} failed, {deploying} deploying
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground font-medium">Last Deployed</p>
          </div>
          {lastDeployed ? (
            <>
              <p className="text-sm font-semibold truncate">{lastDeployed.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {relativeTime(lastDeployed.updateTime)}
              </p>
            </>
          ) : (
            <p className="text-2xl font-bold">—</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Page ───

export default function CloudRunPage() {
  const [services, setServices] = useState<CloudRunService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [appGroup, setAppGroup] = useState<"all" | AppGroup>("all");
  const [expandedService, setExpandedService] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchServices = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const res = await apiFetch<{ data: CloudRunService[] }>("/api/cloud-run");
    if (res.error) {
      setError(res.error);
    } else if (res.data?.data) {
      setServices(res.data.data);
    }

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  const filtered = useMemo(() => {
    return services.filter((svc) => {
      if (appGroup !== "all" && getAppGroupForService(svc.name) !== appGroup) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        svc.name.toLowerCase().includes(q) ||
        svc.imageTag.toLowerCase().includes(q) ||
        svc.uri.toLowerCase().includes(q)
      );
    });
  }, [services, appGroup, search]);

  const toggleExpanded = (name: string) => {
    setExpandedService((prev) => (prev === name ? null : name));
  };

  if (loading) {
    return (
      <>
        <AdminHeader
          title="Cloud Run Services"
          description="Monitor and inspect services running on GCP Cloud Run"
          icon={<Server className="h-6 w-6 text-muted-foreground" />}
        />
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminHeader
        title="Cloud Run Services"
        description="Monitor and inspect services running on GCP Cloud Run"
        icon={<Server className="h-6 w-6 text-muted-foreground" />}
      />

      <TooltipProvider delayDuration={300}>
        <div className="p-6 space-y-6">
          {/* Summary cards */}
          <SummaryCards services={services} loading={false} />

          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 max-w-xs min-w-[200px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search services..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <AppGroupFilter value={appGroup} onChange={setAppGroup} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchServices(true)}
              disabled={refreshing}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 mr-1 ${refreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>

          {/* Result count */}
          <p className="text-sm text-muted-foreground -mt-2">
            {filtered.length} of {services.length} services
          </p>

          {/* Error state */}
          {error && (
            <Card className="border-destructive/30">
              <CardContent className="p-4 flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
                <div>
                  <p className="text-sm font-medium text-destructive">
                    Failed to load services
                  </p>
                  <p className="text-xs text-muted-foreground">{error}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => fetchServices()}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Services table */}
          {!error && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead className="w-8 pl-4" />
                      <TableHead className="text-xs font-semibold">Service</TableHead>
                      <TableHead className="text-xs font-semibold">Status</TableHead>
                      <TableHead className="text-xs font-semibold hidden sm:table-cell">
                        Image Tag
                      </TableHead>
                      <TableHead className="text-xs font-semibold hidden md:table-cell">
                        Last Deployed
                      </TableHead>
                      <TableHead className="text-xs font-semibold hidden lg:table-cell">
                        Scale
                      </TableHead>
                      <TableHead className="text-xs font-semibold hidden xl:table-cell">
                        Env Vars
                      </TableHead>
                      <TableHead className="text-xs font-semibold text-right pr-4">
                        URL
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((svc) => {
                      const isExpanded = expandedService === svc.name;
                      const appGroupLabel = getAppGroupForService(svc.name);

                      return (
                        <>
                          <TableRow
                            key={svc.name}
                            className={`cursor-pointer transition-colors ${
                              isExpanded ? "bg-muted/40" : "hover:bg-muted/20"
                            }`}
                            onClick={() => toggleExpanded(svc.name)}
                          >
                            {/* Expand chevron */}
                            <TableCell className="w-8 pl-4 py-3">
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              )}
                            </TableCell>

                            {/* Service name */}
                            <TableCell className="py-3">
                              <div className="flex items-center gap-2">
                                <div>
                                  <p className="font-medium text-sm">{svc.name}</p>
                                  <div className="flex items-center gap-1.5 mt-0.5">
                                    <Badge
                                      variant="outline"
                                      className="text-xs h-4 px-1.5 font-normal"
                                    >
                                      {appGroupLabel}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground hidden md:inline">
                                      gen {svc.generation}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </TableCell>

                            {/* Status */}
                            <TableCell className="py-3">
                              <StatusBadge status={svc.servingStatus} />
                            </TableCell>

                            {/* Image tag */}
                            <TableCell className="py-3 hidden sm:table-cell">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex items-center gap-1.5 cursor-default">
                                    <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
                                    <code className="text-xs font-mono text-muted-foreground truncate max-w-[120px]">
                                      {svc.imageTag}
                                    </code>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="font-mono text-xs max-w-xs break-all">
                                  {svc.image}
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>

                            {/* Last deployed */}
                            <TableCell className="py-3 hidden md:table-cell">
                              <div className="flex items-center gap-1.5 text-muted-foreground">
                                <Clock className="h-3 w-3 shrink-0" />
                                <span className="text-xs">
                                  {relativeTime(svc.updateTime)}
                                </span>
                              </div>
                            </TableCell>

                            {/* Scale */}
                            <TableCell className="py-3 hidden lg:table-cell">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-xs text-muted-foreground cursor-default">
                                    {svc.minScale}–{svc.maxScale}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">
                                  Min {svc.minScale} / Max {svc.maxScale} instances
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>

                            {/* Env var count */}
                            <TableCell className="py-3 hidden xl:table-cell">
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <Lock className="h-3 w-3 shrink-0" />
                                <span className="text-xs">{svc.envVarCount}</span>
                              </div>
                            </TableCell>

                            {/* URL */}
                            <TableCell className="py-3 text-right pr-4">
                              {svc.uri ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <a
                                      href={svc.uri}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                    >
                                      <Globe className="h-3 w-3" />
                                      <span className="hidden sm:inline">Open</span>
                                      <ExternalLink className="h-2.5 w-2.5" />
                                    </a>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-xs max-w-xs break-all">
                                    {svc.uri}
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>

                          {/* Expanded detail row */}
                          {isExpanded && (
                            <TableRow key={`${svc.name}-detail`} className="bg-muted/10 hover:bg-muted/10">
                              <TableCell colSpan={8} className="px-6 pb-5 pt-2">
                                <Separator className="mb-4" />
                                <ServiceDetailPanel serviceName={svc.name} />
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      );
                    })}

                    {filtered.length === 0 && !loading && (
                      <TableRow>
                        <TableCell
                          colSpan={8}
                          className="text-center text-sm text-muted-foreground py-12"
                        >
                          {search || appGroup !== "all"
                            ? "No services match your filters."
                            : "No Cloud Run services found."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      </TooltipProvider>
    </>
  );
}
