"use client";

import { AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tesserix/web";
import { cn } from "@/lib/utils";

interface DunningPillProps {
  state: "retrying" | "exhausted" | null;
  retryCount?: number;
  lastEventAt?: string;
}

export function DunningPill({ state, retryCount, lastEventAt }: DunningPillProps) {
  if (!state) return null;
  const tone =
    state === "exhausted"
      ? "bg-rose-500/15 text-rose-700"
      : "bg-amber-500/15 text-amber-700";
  const summary = state === "exhausted" ? "Retries exhausted" : "Retrying";
  const detail = lastEventAt
    ? `Last event ${new Date(lastEventAt).toLocaleString()}`
    : retryCount
      ? `${retryCount} attempts`
      : "Stripe is retrying the charge";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            tone,
          )}
        >
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          {summary}
        </button>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}
