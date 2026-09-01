"use client";

// Required even though this component's only @tesserix/web usage is inside
// `DestructiveConfirmDialog` — its barrel is itself "use client", and its
// exports resolve to `undefined` when imported into a server component. See
// `secret-detail-view.tsx`'s identical note.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@tesserix/web";
import { DestructiveConfirmDialog } from "@/components/kit/destructive-confirm-dialog";
import type { SecretStore } from "@/lib/secrets";
import { deleteSecretAction } from "./access-actions";

export interface DestroySecretProps {
  readonly store: SecretStore;
  readonly path: string;
  /** From `page.tsx`'s render-path gate, same as `AccessCard`/`WriteSecretForm`.
   *  Not the security control — `secrets-api` refuses a `platform`-only
   *  caller's delete/destroy outright (403) — but the reason this whole
   *  component renders nothing rather than a disabled pair of buttons: a
   *  control the operator cannot use is worse than no control at all (see
   *  `EraseContactButton`'s identical reasoning in
   *  `crm/[organisation]/organisation-detail-view.tsx`). */
  readonly canWrite: boolean;
}

/**
 * Delete and Destroy: two different facts about the same secret, spec §9's
 * "Destroy requires typing the secret name" made concrete.
 *
 * Delete is a soft delete — reversible from the Versions tab's restore
 * control (`restoreSecretVersion`, not built by this task) — so it takes the
 * plain secondary style the prototype uses for `Remove`/`Reject`, and no
 * typed confirmation: a click is enough friction for something recoverable.
 * Destroy is permanent, so it is the ONE control in this phase using the
 * destructive style, and it sits behind `DestructiveConfirmDialog` with the
 * operator required to type the secret's full path before the confirm
 * button will even accept a click.
 *
 * The comparison is EXACT equality, not `startsWith` or a trimmed/
 * lowercased match the way `crm/[organisation]`'s
 * `useTypedConfirmation` does it for an organisation name: a trailing space
 * or a correct suffix on the wrong prefix must not satisfy it, because a
 * near-miss here destroys the wrong thing rather than merely failing to
 * delete the right one. See `destroy-secret.test.tsx` for the near-miss
 * cases this is asserted against.
 */
export function DestroySecret({ store, path, canWrite }: DestroySecretProps) {
  const router = useRouter();
  const [deletePending, startDeleteTransition] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [destroyOpen, setDestroyOpen] = useState(false);
  const [destroyPending, startDestroyTransition] = useTransition();
  const [destroyError, setDestroyError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  if (!canWrite) {
    return null;
  }

  const destroyMatches = confirmText === path;
  const statusId = "destroy-secret-confirm-status";

  function handleDelete() {
    setDeleteError(null);
    startDeleteTransition(async () => {
      const result = await deleteSecretAction(store, path, false);
      if (!result.ok) {
        setDeleteError(result.message);
        return;
      }
      router.refresh();
    });
  }

  function resetDestroy() {
    setConfirmText("");
    setDestroyError(null);
  }

  function handleDestroy() {
    setDestroyError(null);
    startDestroyTransition(async () => {
      const result = await deleteSecretAction(store, path, true);
      if (!result.ok) {
        setDestroyError(result.message);
        return;
      }
      setDestroyOpen(false);
      resetDestroy();
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Delete</h3>
        <p className="text-sm text-muted-foreground">
          Removes the current version. It stays recoverable — restore it from the Versions tab.
        </p>
        <div>
          <Button type="button" variant="outline" size="sm" disabled={deletePending} onClick={handleDelete}>
            Delete
          </Button>
        </div>
        {deleteError && (
          <p role="alert" className="text-sm text-destructive">
            {deleteError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Destroy</h3>
        <p className="text-sm text-muted-foreground">
          Permanently removes this secret. Unlike Delete, this cannot be undone.
        </p>
        <div>
          <Button type="button" variant="destructive" size="sm" onClick={() => setDestroyOpen(true)}>
            Destroy
          </Button>
        </div>
      </div>

      <DestructiveConfirmDialog
        open={destroyOpen}
        onOpenChange={(next) => {
          setDestroyOpen(next);
          if (!next) resetDestroy();
        }}
        title={`Destroy ${path}?`}
        description="This permanently removes the secret. Unlike Delete, there is no restore afterwards."
        confirmLabel="Destroy"
        confirmId="destroy-secret-confirm-button"
        statusId={statusId}
        loading={destroyPending}
        confirmDisabled={!destroyMatches}
        onConfirm={handleDestroy}
      >
        <div className="mt-2">
          <Label htmlFor="destroy-secret-confirm-input">
            Type <span className="font-mono">{path}</span> to confirm
          </Label>
          <Input
            id="destroy-secret-confirm-input"
            className="mt-1"
            value={confirmText}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={statusId}
            onChange={(event) => setConfirmText(event.target.value)}
          />
          {/* `aria-live` announces the reason the confirm button is
           *  unreachable — and the moment it stops being unreachable — the
           *  same reasoning `ConfirmTypedName` gives in
           *  `crm/[organisation]/organisation-detail-view.tsx`. Unlike that
           *  copy, this one does not say "not case-sensitive": it is. */}
          <p id={statusId} aria-live="polite" className="mt-1 text-xs text-muted-foreground">
            {destroyMatches
              ? "Path matches. The confirm button is enabled."
              : `Confirm button is disabled until this matches "${path}" exactly.`}
          </p>
          {destroyError && (
            <p role="alert" className="mt-1 text-sm text-destructive">
              {destroyError}
            </p>
          )}
        </div>
      </DestructiveConfirmDialog>
    </div>
  );
}
