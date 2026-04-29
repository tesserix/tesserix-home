"use client";

import { useEffect, useRef } from "react";
import { Rocket, RefreshCw } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  ServicesTab,
  ServicesTabSkeleton,
} from "@/components/admin/releases/services-tab";
import {
  PipelinesTab,
  PipelinesTabSkeleton,
} from "@/components/admin/releases/pipelines-tab";
import {
  RegistryTab,
} from "@/components/admin/releases/registry-tab";
import {
  GoSharedTab,
} from "@/components/admin/releases/go-shared-tab";
import {
  HistoryTab,
} from "@/components/admin/releases/history-tab";
import {
  HealthTab,
} from "@/components/admin/releases/health-tab";
import { DependencyGraph } from "@/components/admin/releases/dependency-graph";
import { useServices, usePipelines } from "@/lib/api/releases";
import { Button, Badge, Tabs, TabsContent, TabsList, TabsTrigger, ErrorState } from "@tesserix/web";

export default function ReleasesPage() {
  const {
    data: servicesData,
    isLoading: servicesLoading,
    error: servicesError,
    mutate: refreshServices,
  } = useServices();
  const {
    data: pipelinesData,
    isLoading: pipelinesLoading,
    error: pipelinesError,
    mutate: refreshPipelines,
  } = usePipelines();

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-refresh every 30s while the tab is visible
  useEffect(() => {
    function refresh() {
      refreshServices();
      refreshPipelines();
    }
    function start() {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(refresh, 30_000);
    }
    function stop() {
      if (!intervalRef.current) return;
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refresh();
        start();
      } else {
        stop();
      }
    }
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshServices, refreshPipelines]);

  const handleRefresh = () => {
    refreshServices();
    refreshPipelines();
  };

  const handlePromoteSuccess = () => {
    setTimeout(() => {
      refreshServices();
      refreshPipelines();
    }, 2000);
  };

  const hasInProgress = pipelinesData?.data.some(
    (p) => p.status === "in_progress"
  );

  const lastUpdated =
    servicesData?.lastUpdated || pipelinesData?.lastUpdated;

  return (
    <>
      <AdminHeader
        title="Releases"
        description="Monitor builds, manage services, and promote to production"
        icon={<Rocket className="h-6 w-6 text-muted-foreground" />}
      />

      <main className="p-6 space-y-6">
        {/* Refresh bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {hasInProgress && (
              <Badge variant="warning" className="gap-1 animate-pulse">
                Live
              </Badge>
            )}
            <p className="text-sm text-muted-foreground">
              {lastUpdated
                ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}`
                : "Loading..."}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="services">
          <TabsList>
            <TabsTrigger value="services">Services</TabsTrigger>
            <TabsTrigger value="registry">Registry</TabsTrigger>
            <TabsTrigger value="go-shared">go-shared</TabsTrigger>
            <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
            <TabsTrigger value="health">Health</TabsTrigger>
          </TabsList>

          <TabsContent value="services">
            {servicesLoading ? (
              <ServicesTabSkeleton />
            ) : servicesError ? (
              <ErrorState message={servicesError} onRetry={refreshServices} />
            ) : (
              <ServicesTab
                services={servicesData?.data ?? []}
                onPromoteSuccess={handlePromoteSuccess}
              />
            )}
          </TabsContent>

          <TabsContent value="registry">
            <RegistryTab />
          </TabsContent>

          <TabsContent value="go-shared">
            <GoSharedTab />
          </TabsContent>

          <TabsContent value="pipelines">
            {pipelinesLoading ? (
              <PipelinesTabSkeleton />
            ) : pipelinesError ? (
              <ErrorState
                message={pipelinesError}
                onRetry={refreshPipelines}
              />
            ) : (
              <PipelinesTab
                pipelines={pipelinesData?.data ?? []}
                onRefresh={handleRefresh}
              />
            )}
          </TabsContent>

          <TabsContent value="history">
            <HistoryTab />
          </TabsContent>

          <TabsContent value="dependencies">
            <DependencyGraph />
          </TabsContent>

          <TabsContent value="health">
            <HealthTab />
          </TabsContent>
        </Tabs>
      </main>
    </>
  );
}
