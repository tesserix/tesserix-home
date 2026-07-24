"use client";

import { cn } from "@/lib/utils";

interface PlanBadgeProps {
  plan: string;
}

// Monochrome weight-based hierarchy per UX-SPEC §badge taxonomy.
// Trial gets outlined/muted to make paying-vs-not-paying readable at a glance.
const PLAN_STYLES: Readonly<Record<string, string>> = {
  trial: "border border-border bg-transparent text-muted-foreground",
  starter: "bg-muted/60 text-foreground/80",
  studio: "bg-muted text-foreground",
  pro: "bg-foreground/85 text-background",
  marketplace: "bg-foreground text-background ring-1 ring-foreground/20",
};

export function PlanBadge({ plan }: PlanBadgeProps) {
  const style = PLAN_STYLES[plan] ?? "bg-muted text-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize",
        style,
      )}
    >
      {plan}
    </span>
  );
}
