"use client";

import { useState } from "react";
import {
  Undo2,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import {
  useRollbackVersions,
  rollbackService,
} from "@/lib/api/releases";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Skeleton,
} from "@tesserix/web";

interface RollbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceName: string;
  serviceDisplayName: string;
  currentVersion: string | null;
  hasDb: boolean;
  onSuccess: () => void;
}

export function RollbackDialog({
  open,
  onOpenChange,
  serviceName,
  serviceDisplayName,
  currentVersion,
  hasDb,
  onSuccess,
}: RollbackDialogProps) {
  const { data, isLoading } = useRollbackVersions(open ? serviceName : null);
  const [selected, setSelected] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versions = (data?.data ?? []).filter(
    (v) => v.version !== currentVersion
  );

  const handleRollback = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    setError(null);
    const result = await rollbackService(serviceName, selected);
    setIsSubmitting(false);
    if (result.error) {
      setError(result.error);
    } else {
      onOpenChange(false);
      setSelected(null);
      onSuccess();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setSelected(null);
          setError(null);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2  className="h-5 w-5" aria-hidden="true" />
            Rollback {serviceDisplayName}
          </DialogTitle>
          <DialogDescription>
            Current version:{" "}
            {currentVersion ? (
              <span className="font-mono">v{currentVersion}</span>
            ) : (
              "unknown"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Version list */}
          <div>
            <p className="text-sm font-medium mb-2">Select target version:</p>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : versions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No previous versions available.
              </p>
            ) : (
              <div className="space-y-1 max-h-[240px] overflow-y-auto">
                {versions.map((v) => (
                  <label
                    key={v.version}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selected === v.version
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted/30"
                    }`}
                  >
                    <input
                      type="radio"
                      name="rollback-version"
                      checked={selected === v.version}
                      onChange={() => setSelected(v.version)}
                      className="accent-primary"
                    />
                    <div className="flex-1">
                      <Badge
                        variant={
                          selected === v.version ? "default" : "outline"
                        }
                        className="font-mono text-xs"
                      >
                        v{v.version}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground font-mono">
                      {v.sha}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Rollback explanation */}
          {selected && (
            <div className="text-sm text-muted-foreground space-y-1">
              <p>Rolling back to v{selected} will:</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>Deploy the existing Docker image (no rebuild)</li>
                <li>Create a new Cloud Run revision</li>
                <li>Not affect other services</li>
              </ul>
            </div>
          )}

          {/* Schema warning */}
          {hasDb && selected && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-warning/30 bg-warning/5">
              <AlertTriangle  className="h-4 w-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-warning">
                Schema migrations are NOT reversed automatically. Ensure v
                {selected} is compatible with the current database schema.
              </p>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleRollback}
            disabled={!selected || isSubmitting}
          >
            {isSubmitting ? (
              <Loader2  className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />
            ) : (
              <Undo2  className="h-4 w-4 mr-2" aria-hidden="true" />
            )}
            Confirm Rollback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
