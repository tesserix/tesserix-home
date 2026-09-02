"use client";

// Required for the same reason `destroy-secret.tsx` gives: @tesserix/web's
// barrel is itself "use client", and its exports resolve to `undefined` when
// imported into a server component.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@tesserix/web";
import type { SecretStore, SecretVersion } from "@/lib/secrets";
import { restoreSecretVersionAction } from "./access-actions";

export interface RestoreVersionControlProps {
  readonly store: SecretStore;
  readonly path: string;
  readonly version: SecretVersion;
  /** From `page.tsx`'s render-path gate, threaded through
   *  `SecretDetailView`'s Versions tab. Not the security control —
   *  `secrets-api` refuses a `platform`-only caller's restore outright (403,
   *  it is a `live`-tier route) — but the reason this renders nothing rather
   *  than a disabled button, exactly as `DestroySecret` does for delete and
   *  destroy. The Versions TABLE stays visible to every viewer either way;
   *  only this control is gated. */
  readonly canWrite: boolean;
}

/**
 * The Restore control the Delete tab's copy has been promising: "It stays
 * recoverable — restore it from the Versions tab."
 *
 * Which versions it is offered for is the whole of this component's
 * judgement: destroyed → nothing (unrecoverable), deleted → Restore,
 * neither → nothing (there is nothing to restore on a live version).
 *
 * THE `destroyed` GUARD BELOW MUST EXIST. That is the load-bearing fact
 * about it — not where it sits. KV v2's only path to `destroyed` passes
 * through `deleted`, so a destroyed version carries BOTH flags, and without
 * its own guard it would fall to the `deleted` one and be offered Restore.
 * `secrets-api`'s `Restore` handler refuses a destroyed version (see
 * `restoreSecretVersionAction`'s doc comment), so that button could never
 * succeed — the same class of defect as copy pointing at a control that
 * does not exist, which is the defect this whole component was added to fix.
 *
 * Its POSITION relative to the `deleted` guard is not load-bearing, and no
 * future reader should preserve the order at the cost of the guard: both
 * guards return `null`, so swapping them changes nothing for any input.
 * `VersionStatusBadge` in `secret-detail-view.tsx` is genuinely different —
 * each of its branches renders DIFFERENT content, so a destroyed version
 * reaching the `deleted` branch first would render the wrong label. Do not
 * carry that rationale across to here; only the guard's existence matters.
 *
 * No typed-name confirmation, unlike the Destroy control in
 * `destroy-secret.tsx`: that confirmation exists because destroy cannot be
 * undone. A restore can — delete it again — so a click is enough friction.
 */
export function RestoreVersionControl({
  store,
  path,
  version,
  canWrite,
}: RestoreVersionControlProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canWrite) return null;
  if (version.destroyed) return null;
  if (!version.deleted) return null;

  function handleRestore() {
    setError(null);
    startTransition(async () => {
      const result = await restoreSecretVersionAction(store, path, version.version);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Re-read rather than flipping `deleted` locally — the same reasoning
      // `AccessCard.refreshAfterChange` gives: the version list can also
      // change from outside this page, so the server is the only source of
      // truth for it. Leaving the row reading "Deleted" after a successful
      // restore would be the same "the UI asserts something untrue" defect
      // this control was added to fix.
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        // Every restorable row renders a button reading "Restore", so the
        // version number goes in the accessible name — otherwise a screen
        // reader (and a test) sees several identically named controls with
        // no way to tell which version each acts on.
        aria-label={`Restore version ${version.version}`}
        onClick={handleRestore}
      >
        Restore
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
