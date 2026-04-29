"use client";

import { useState } from "react";
import {
  Package,
  Rocket,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import {
  useGoShared,
  triggerGoSharedRelease,
  type GoSharedConsumerStatus,
} from "@/lib/api/releases";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Progress,
  Skeleton,
  Separator,
} from "@tesserix/web";

function bumpVersion(
  version: string,
  type: "patch" | "minor" | "major"
): string {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return version;
  const [major, minor, patch] = parts;
  switch (type) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
  }
}

const STATUS_ICON: Record<
  GoSharedConsumerStatus,
  { icon: typeof CheckCircle2; color: string; label: string }
> = {
  updated: {
    icon: CheckCircle2,
    color: "text-success",
    label: "Updated",
  },
  pending: { icon: Clock, color: "text-warning", label: "Pending" },
  failed: { icon: XCircle, color: "text-error", label: "Failed" },
};

function TriggerReleaseDialog({
  open,
  onOpenChange,
  currentVersion,
  pendingCount,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentVersion: string;
  pendingCount: number;
  onSuccess: () => void;
}) {
  const [bumpType, setBumpType] = useState<"patch" | "minor" | "major" | "custom">("patch");
  const [customVersion, setCustomVersion] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const version =
    bumpType === "custom"
      ? customVersion
      : bumpVersion(currentVersion, bumpType);

  const handleSubmit = async () => {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      setError("Version must be in semver format (e.g. 1.2.3)");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    const result = await triggerGoSharedRelease(version);
    setIsSubmitting(false);
    if (result.error) {
      setError(result.error);
    } else {
      onOpenChange(false);
      onSuccess();
    }
  };

  const bumps = [
    { type: "patch" as const, label: "Patch", version: bumpVersion(currentVersion, "patch") },
    { type: "minor" as const, label: "Minor", version: bumpVersion(currentVersion, "minor") },
    { type: "major" as const, label: "Major", version: bumpVersion(currentVersion, "major") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Trigger go-shared Release</DialogTitle>
          <DialogDescription>
            Current version: v{currentVersion}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">New version</p>
            {bumps.map((b) => (
              <label
                key={b.type}
                className="flex items-center gap-3 p-2 rounded-lg border cursor-pointer hover:bg-muted/30 transition-colors"
              >
                <input
                  type="radio"
                  name="bump"
                  checked={bumpType === b.type}
                  onChange={() => setBumpType(b.type)}
                  className="accent-primary"
                />
                <span className="text-sm">{b.label}</span>
                <Badge variant="secondary" className="ml-auto font-mono text-xs">
                  v{b.version}
                </Badge>
              </label>
            ))}
            <label className="flex items-center gap-3 p-2 rounded-lg border cursor-pointer hover:bg-muted/30 transition-colors">
              <input
                type="radio"
                name="bump"
                checked={bumpType === "custom"}
                onChange={() => setBumpType("custom")}
                className="accent-primary"
              />
              <span className="text-sm">Custom</span>
              {bumpType === "custom" && (
                <Input
                  placeholder="1.2.3"
                  value={customVersion}
                  onChange={(e) => {
                    setCustomVersion(e.target.value);
                    setError(null);
                  }}
                  className="ml-auto font-mono h-7 w-32 text-xs"
                  autoFocus
                />
              )}
            </label>
          </div>

          <Separator />

          <div className="text-sm text-muted-foreground space-y-1">
            <p>This will:</p>
            <ul className="list-disc list-inside space-y-0.5 text-xs">
              <li>Create a GitHub release tag on tesserix/go-shared</li>
              <li>Dispatch update events to all dependent repos</li>
              <li>Open automated PRs with go.mod updates</li>
            </ul>
          </div>

          {pendingCount > 0 && (
            <div className="flex items-center gap-2 p-2 rounded-lg border border-warning/30 bg-warning/5">
              <Clock className="h-4 w-4 text-warning shrink-0" aria-hidden="true" />
              <p className="text-xs text-warning">
                {pendingCount} repos have pending updates from v{currentVersion}.
              </p>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />
            ) : (
              <Rocket className="h-4 w-4 mr-2" aria-hidden="true" />
            )}
            Trigger Release
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GoSharedTabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}

export function GoSharedTab() {
  const { data, isLoading, error, mutate } = useGoShared();
  const [triggerOpen, setTriggerOpen] = useState(false);

  if (isLoading) return <GoSharedTabSkeleton />;

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

  const consumers = data?.consumers ?? [];
  const currentVersion = data?.currentVersion ?? "0.0.0";
  const previousVersion = data?.previousVersion;
  const updatedCount = consumers.filter((c) => c.status === "updated").length;
  const pendingCount = consumers.filter((c) => c.status === "pending").length;
  const failedCount = consumers.filter((c) => c.status === "failed").length;
  const progress =
    consumers.length > 0 ? (updatedCount / consumers.length) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-chart-5/10">
            <Package className="h-5 w-5 text-chart-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">go-shared</h3>
            <p className="text-xs text-muted-foreground font-mono">
              tesserix/go-shared
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={mutate}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setTriggerOpen(true)}>
            <Rocket className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Trigger Release
          </Button>
        </div>
      </div>

      {/* Main layout */}
      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        {/* Left: Version info */}
        <div className="space-y-3">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div>
                <p className="text-xs text-muted-foreground">Current</p>
                <Badge variant="default" className="font-mono text-sm mt-1">
                  v{currentVersion}
                </Badge>
              </div>
              {previousVersion && (
                <div>
                  <p className="text-xs text-muted-foreground">Previous</p>
                  <Badge
                    variant="outline"
                    className="font-mono text-xs mt-1"
                  >
                    v{previousVersion}
                  </Badge>
                </div>
              )}
              <Separator />
              <a
                href="https://github.com/tesserix/go-shared/releases"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                View Changelog
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </CardContent>
          </Card>

          {/* Stats */}
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Updated
                </span>
                <span className="font-medium">{updatedCount}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-warning">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  Pending
                </span>
                <span className="font-medium">{pendingCount}</span>
              </div>
              {failedCount > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-error">
                    <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    Failed
                  </span>
                  <span className="font-medium">{failedCount}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: Propagation status */}
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">Propagation Status</h4>
              <span className="text-xs text-muted-foreground">
                {updatedCount} / {consumers.length} updated
              </span>
            </div>

            <Progress value={progress} className="h-2" />

            {consumers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No go-shared consumers found.
              </p>
            ) : (
              <div className="space-y-1">
                {consumers.map((consumer) => {
                  const statusInfo = STATUS_ICON[consumer.status];
                  const Icon = statusInfo.icon;

                  return (
                    <div
                      key={consumer.name}
                      className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Icon
                          className={`h-4 w-4 shrink-0 ${statusInfo.color}`}
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {consumer.displayName}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono truncate">
                            {consumer.name}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {consumer.currentVersion ? (
                          <Badge
                            variant={
                              consumer.status === "updated"
                                ? "default"
                                : "outline"
                            }
                            className="font-mono text-xs"
                          >
                            v{consumer.currentVersion}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">
                            Unknown
                          </Badge>
                        )}
                        <span
                          className={`text-xs ${statusInfo.color}`}
                        >
                          {statusInfo.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trigger Release Dialog */}
      <TriggerReleaseDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        currentVersion={currentVersion}
        pendingCount={pendingCount}
        onSuccess={() => {
          setTimeout(mutate, 2000);
        }}
      />
    </div>
  );
}
