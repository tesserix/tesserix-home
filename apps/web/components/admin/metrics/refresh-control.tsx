"use client";

import { useState } from "react";
import { Button, useToast } from "@tesserix/web";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface RefreshControlProps {
  onRefresh: () => void | Promise<void>;
  loading?: boolean;
  successMessage?: string;
}

export function RefreshControl({ onRefresh, loading, successMessage = "Metrics refreshed" }: RefreshControlProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const isBusy = busy || loading;

  async function handleClick() {
    setBusy(true);
    try {
      await onRefresh();
      toast({ title: successMessage });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      disabled={isBusy}
      aria-label="Refresh metrics"
      className="h-8 w-8"
    >
      <RefreshCw className={cn("h-4 w-4", isBusy && "motion-safe:animate-spin")} />
    </Button>
  );
}
