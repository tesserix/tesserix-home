import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import type { BuildStatus } from "@/lib/api/releases";

const STATUS_CONFIG: Record<
  BuildStatus,
  { label: string; variant: "success" | "destructive" | "warning" | "secondary" }
> = {
  success: { label: "Success", variant: "success" },
  failure: { label: "Failed", variant: "destructive" },
  in_progress: { label: "Running", variant: "warning" },
  queued: { label: "Queued", variant: "secondary" },
  cancelled: { label: "Cancelled", variant: "secondary" },
  none: { label: "N/A", variant: "secondary" },
};

export function StatusBadge({
  status,
  label,
}: {
  status: BuildStatus;
  label?: string;
}) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.none;
  return (
    <Badge variant={config.variant} className="gap-1">
      {status === "in_progress" && (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      {label ?? config.label}
    </Badge>
  );
}

export function WorkflowTypeBadge({
  type,
}: {
  type: "build" | "release" | "other";
}) {
  if (type === "build") {
    return (
      <Badge variant="outline" className="text-xs">
        Build
      </Badge>
    );
  }
  if (type === "release") {
    return (
      <Badge variant="default" className="text-xs">
        Release
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs">
      Other
    </Badge>
  );
}
