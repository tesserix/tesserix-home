"use client";

import { useActionState, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@tesserix/web";
import type {
  FeatureFlagCommand,
  FeatureFlagWriteResult,
} from "@/lib/feature-flags-contract";

export type RecoveryAction = (input: {
  command: string;
  operation: "resume" | "cancel";
}) => Promise<FeatureFlagWriteResult>;

export function CommandRecovery({
  command,
  requester,
  onRecover,
  onResult,
}: {
  command: FeatureFlagCommand;
  requester: boolean;
  onRecover: RecoveryAction;
  onResult: (result: FeatureFlagWriteResult) => void;
}) {
  const [operation, setOperation] = useState<"resume" | "cancel" | null>(null);
  const [state, action, pending] = useActionState(
    async (): Promise<FeatureFlagWriteResult> => {
      if (!operation) return { ok: false, message: "Choose an operation." };
      let result: FeatureFlagWriteResult;
      try {
        result = await onRecover({ command: command.id, operation });
      } catch {
        result = {
          ok: false,
          message:
            "The outcome could not be confirmed. Refresh command history before continuing.",
        };
      }
      onResult(result);
      if (result.ok) setOperation(null);
      return result;
    },
    { ok: false, message: "" },
  );

  if (command.state !== "queued") return null;
  return (
    <>
      <div className="mt-3 flex gap-2">
        {requester && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOperation("resume")}
          >
            Resume request
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOperation("cancel")}
        >
          Cancel queued request
        </Button>
      </div>
      <Dialog
        open={operation !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setOperation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {operation === "resume"
                ? "Resume queued change?"
                : "Cancel queued change?"}
            </DialogTitle>
            <DialogDescription>
              {operation === "resume"
                ? "The original request and release checks will be used. A stale request will fail safely."
                : "Cancellation only succeeds before dispatch. It cannot stop or reverse a change already sent to GrowthBook."}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">{command.reason}</p>
          {state.message && (
            <p role="status" className="text-sm text-muted-foreground">
              {state.message}
            </p>
          )}
          <form action={action}>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOperation(null)}
              >
                Go back
              </Button>
              <Button type="submit" disabled={pending}>
                {pending
                  ? "Confirming…"
                  : operation === "resume"
                    ? "Confirm resume"
                    : "Confirm cancellation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
