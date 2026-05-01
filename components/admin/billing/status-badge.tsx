"use client";

import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
}

// Color-coded by Stripe status semantics; text always carries meaning so
// color is never the sole encoding (per UX-SPEC accessibility).
const STATUS_STYLES: Readonly<Record<string, string>> = {
  active: "bg-emerald-500/15 text-emerald-700",
  trialing: "bg-sky-500/15 text-sky-700",
  past_due: "bg-amber-500/15 text-amber-700",
  unpaid: "bg-rose-500/15 text-rose-700",
  incomplete: "bg-amber-500/10 text-amber-600",
  incomplete_expired: "bg-muted text-muted-foreground",
  canceled: "bg-muted text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Readonly<Record<string, string>> = {
  active: "Active",
  trialing: "Trialing",
  past_due: "Past due",
  unpaid: "Unpaid",
  incomplete: "Incomplete",
  incomplete_expired: "Incomplete (expired)",
  canceled: "Cancelled",
  paused: "Paused",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const style = STATUS_STYLES[status] ?? "bg-muted text-muted-foreground";
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        style,
      )}
    >
      {label}
    </span>
  );
}
