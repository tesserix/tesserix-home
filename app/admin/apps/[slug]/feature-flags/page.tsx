"use client";

import { useState, use } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import {
  useFeatureFlags,
  useExperiments,
  setOverride,
  clearOverride,
  type FeatureFlag,
  type ExperimentStatus,
} from "@/lib/api/feature-flags";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

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

function FlagActions({
  flag,
  onMutate,
}: {
  flag: FeatureFlag;
  onMutate: () => void;
}) {
  const [loading, setLoading] = useState(false);

  async function handleOverride(value: boolean) {
    setLoading(true);
    await setOverride(flag.key, value);
    setLoading(false);
    onMutate();
  }

  async function handleClear() {
    setLoading(true);
    await clearOverride(flag.key);
    setLoading(false);
    onMutate();
  }

  const hasOverride = flag.overrides && flag.overrides.length > 0;

  return (
    <div className="flex items-center gap-2">
      {hasOverride ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleClear}
          disabled={loading}
        >
          Clear Override
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOverride(!flag.enabled)}
            disabled={loading}
          >
            {flag.enabled ? "Force Off" : "Force On"}
          </Button>
        </>
      )}
    </div>
  );
}

export default function AppFeatureFlagsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const appName = APP_NAMES[slug] || slug;
  const [activeTab, setActiveTab] = useState<"flags" | "experiments">("flags");
  const {
    data: flags,
    isLoading: flagsLoading,
    error: flagsError,
    mutate: mutateFlags,
  } = useFeatureFlags();
  const {
    data: experiments,
    isLoading: experimentsLoading,
    error: experimentsError,
    mutate: mutateExperiments,
  } = useExperiments();

  return (
    <>
      <AdminHeader
        title="Feature Flags"
        description={`Manage feature flags and experiments for ${appName}`}
      />

      <main className="p-6 space-y-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href={`/admin/apps/${slug}`} className="hover:text-foreground transition-colors">
            {appName}
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Feature Flags</span>
        </nav>

        {/* Tabs */}
        <div className="flex gap-2 border-b">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "flags"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("flags")}
          >
            Feature Flags
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "experiments"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("experiments")}
          >
            Experiments
          </button>
        </div>

        {activeTab === "flags" && (
          <>
            {flagsLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : flagsError ? (
              <ErrorState message={flagsError} onRetry={mutateFlags} />
            ) : !flags || flags.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground">
                    No feature flags configured.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Key</th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Name</th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Status</th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Description</th>
                      <th className="h-10 px-4 text-right font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flags.map((flag) => (
                      <tr
                        key={flag.key}
                        className="border-b hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono text-xs">{flag.key}</td>
                        <td className="px-4 py-3 font-medium">{flag.name}</td>
                        <td className="px-4 py-3">
                          <Badge variant={flag.enabled ? "success" : "secondary"}>
                            {flag.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">
                          {flag.description || "\u2014"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <FlagActions flag={flag} onMutate={mutateFlags} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {activeTab === "experiments" && (
          <>
            {experimentsLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : experimentsError ? (
              <ErrorState
                message={experimentsError}
                onRetry={mutateExperiments}
              />
            ) : !experiments || experiments.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground">
                    No experiments configured.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Name</th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Feature Key</th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Status</th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Variants</th>
                      <th className="h-10 px-4 text-left font-medium text-muted-foreground">Date Range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {experiments.map((exp) => (
                      <tr
                        key={exp.id}
                        className="border-b hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <Link
                            href={`/admin/apps/${slug}/feature-flags/${exp.id}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {exp.name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{exp.feature_key}</td>
                        <td className="px-4 py-3">
                          <Badge variant={experimentStatusVariant(exp.status)}>
                            {exp.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">{exp.variants?.length || 0} variants</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {exp.start_date
                            ? new Date(exp.start_date).toLocaleDateString()
                            : "\u2014"}{" "}
                          \u2014{" "}
                          {exp.end_date
                            ? new Date(exp.end_date).toLocaleDateString()
                            : "ongoing"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
