"use client";

import type { ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@tesserix/web";

/**
 * The shared destructive-confirmation shell.
 *
 * Built on `Dialog`'s own primitives, not the packaged `ConfirmDialog`: its
 * confirm button doesn't accept `aria-describedby`, and that association —
 * pointing the button at a status text a caller renders inside `children` —
 * is what a screen-reader operator needs to learn why a confirm button is
 * unreachable (a typed-name gate) or simply what it is about to do.
 *
 * Originally local to `crm/[organisation]/organisation-detail-view.tsx`
 * (organisation delete, contact erasure). Promoted here on its second use —
 * the tools directory's per-tool delete (`components/tools-admin/
 * tools-manager.tsx`) — rather than left for a third caller to hand-roll its
 * own copy. See Ruling 17 in `lib/crm-write.ts` for what happened the one
 * time that was allowed to happen here: a second surface's copy of a shared
 * control diverged from the original twice within a single review round.
 *
 * `statusId` is optional: the organisation/contact callers point it at a
 * typed-confirmation's live status paragraph; a caller with no such gate
 * (nothing to describe) simply omits it, and the confirm button carries no
 * `aria-describedby` rather than one pointing at an element that doesn't
 * exist.
 */
export function DestructiveConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmId,
  statusId,
  loading,
  confirmDisabled,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmId: string;
  statusId?: string;
  loading: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            id={confirmId}
            type="button"
            variant="destructive"
            aria-describedby={statusId}
            disabled={loading || Boolean(confirmDisabled)}
            onClick={onConfirm}
          >
            {loading ? "Please wait…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
