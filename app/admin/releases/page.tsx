"use client";

import { useEffect, useRef } from "react";
import { Rocket, RefreshCw } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorState } from "@/components/admin/error-state";
import {
  ServicesTab,
  ServicesTabSkeleton,
} from "@/components/admin/releases/services-tab";
import {
  PipelinesTab,
  PipelinesTabSkeleton,
} from "@/components/admin/releases/pipelines-tab";
import { useServices, usePipelines } from "@/lib/api/releases";

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

  // Auto-refresh every 30s
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      refreshServices();
      refreshPipelines();
    }, 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
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
        description="Monitor builds and promote services to production"
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
            <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
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
        </Tabs>
      </main>
    </>
  );
}
