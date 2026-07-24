"use client";

import { cn } from "@/lib/utils";

const STYLES: Readonly<Record<string, string>> = {
  info: "bg-muted text-muted-foreground",
  warning: "bg-amber-500/15 text-amber-700",
  critical: "bg-rose-500/15 text-rose-700",
};

const LABEL: Readonly<Record<string, string>> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        STYLES[severity] ?? STYLES.info,
      )}
    >
      {LABEL[severity] ?? severity}
    </span>
  );
}
