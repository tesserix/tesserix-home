"use client";

import { Button } from "@tesserix/web";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface RefreshControlProps {
  onRefresh: () => void;
  loading?: boolean;
}

export function RefreshControl({ onRefresh, loading }: RefreshControlProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onRefresh}
      disabled={loading}
      aria-label="Refresh metrics"
      className="h-8 w-8"
    >
      <RefreshCw className={cn("h-4 w-4", loading && "motion-safe:animate-spin")} />
    </Button>
  );
}
