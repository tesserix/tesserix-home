"use client";

// Scoped error boundary for /admin/**. Renders inside AdminLayout so the
// sidebar + header stay visible — only the main-content area is replaced.
// Without this, app/error.tsx catches the error and blanks the whole shell.

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@tesserix/web";

import { AdminHeader } from "@/components/admin/header";
import { logger } from "@/lib/logger";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("admin segment error", error);
  }, [error]);

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Something went wrong" />
      <div className="flex-1 p-6">
        <div className="mx-auto max-w-2xl space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-destructive" aria-hidden="true" />
            <div className="space-y-1">
              <h2 className="text-base font-medium text-foreground">This page failed to load</h2>
              <p className="text-sm text-muted-foreground">
                {error.message || "An unexpected error occurred while rendering this page."}
              </p>
              {error.digest ? (
                <p className="font-mono text-xs text-muted-foreground/70">id: {error.digest}</p>
              ) : null}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={() => reset()} size="sm" className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={() => (window.location.href = "/admin/dashboard")}>
              Go to dashboard
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
