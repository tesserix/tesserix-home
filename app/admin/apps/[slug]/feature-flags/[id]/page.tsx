"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import { useExperiment, type ExperimentStatus } from "@/lib/api/feature-flags";

function experimentStatusVariant(status: ExperimentStatus): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "running":
      return "success";
    case "paused":
      return "warning";
    case "completed":
      return "secondary";
    case "draft":
    default:
      return "secondary";
  }
}

export default function AppExperimentDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);
  const { data: experiment, isLoading, error, mutate } = useExperiment(id);

  if (isLoading) {
    return (
      <>
        <AdminHeader title="Experiment" description="Loading..." />
        <main className="p-6 space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </main>
      </>
    );
  }

  if (error) {
    return (
      <>
        <AdminHeader title="Experiment" />
        <main className="p-6">
          <ErrorState message={error} onRetry={mutate} />
        </main>
      </>
    );
  }

  if (!experiment) {
    return (
      <>
        <AdminHeader title="Experiment" />
        <main className="p-6">
          <ErrorState message="Experiment not found" />
        </main>
      </>
    );
  }

  return (
    <>
      <AdminHeader
        title={experiment.name}
        description={experiment.description}
      />

      <main className="p-6 space-y-6">
        {/* Back link */}
        <Link
          href={`/admin/apps/${slug}/feature-flags`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Feature Flags
        </Link>

        {/* Status */}
        <div className="flex items-center gap-3">
          <Badge variant={experimentStatusVariant(experiment.status)}>
            {experiment.status}
          </Badge>
          <span className="text-sm text-muted-foreground font-mono">
            Feature: {experiment.feature_key}
          </span>
          <span className="text-sm text-muted-foreground">
            {experiment.start_date
              ? new Date(experiment.start_date).toLocaleDateString()
              : "\u2014"}{" "}
            \u2014{" "}
            {experiment.end_date
              ? new Date(experiment.end_date).toLocaleDateString()
              : "ongoing"}
          </span>
        </div>

        {/* Variants */}
        <div>
          <h3 className="text-lg font-semibold mb-4">Variants</h3>
          {!experiment.variants || experiment.variants.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground">No variants configured.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {experiment.variants.map((variant, i) => (
                <Card key={i}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{variant.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Weight</span>
                      <span className="font-medium">{variant.weight}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Value</span>
                      <span className="font-mono text-xs">
                        {JSON.stringify(variant.value)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Metrics */}
        {experiment.metrics && (
          <div>
            <h3 className="text-lg font-semibold mb-4">Metrics</h3>
            <Card>
              <CardContent className="p-6">
                <p className="text-sm text-muted-foreground mb-4">
                  Total Participants:{" "}
                  <span className="font-bold text-foreground">
                    {experiment.metrics.total_participants.toLocaleString()}
                  </span>
                </p>
                {experiment.metrics.variant_results && (
                  <div className="rounded-md border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          <th className="h-10 px-4 text-left font-medium text-muted-foreground">Variant</th>
                          <th className="h-10 px-4 text-left font-medium text-muted-foreground">Participants</th>
                          <th className="h-10 px-4 text-left font-medium text-muted-foreground">Conversions</th>
                          <th className="h-10 px-4 text-left font-medium text-muted-foreground">Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(experiment.metrics.variant_results).map(
                          ([name, result]) => (
                            <tr key={name} className="border-b">
                              <td className="px-4 py-3 font-medium">{name}</td>
                              <td className="px-4 py-3">
                                {result.participants.toLocaleString()}
                              </td>
                              <td className="px-4 py-3">
                                {result.conversions.toLocaleString()}
                              </td>
                              <td className="px-4 py-3 font-mono">
                                {(result.conversion_rate * 100).toFixed(2)}%
                              </td>
                            </tr>
                          )
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </>
  );
}
