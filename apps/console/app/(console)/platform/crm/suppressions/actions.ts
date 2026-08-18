"use server";

import { revalidatePath } from "next/cache";
import { addSuppression, removeSuppression } from "@/lib/db/crm-repo";
import { withCrmWrite, type CrmActionResult } from "@/lib/crm-write";


/**
 * The do-not-contact list's two writes, both through `withCrmWrite`
 * (Ruling 17): session check, capability gate, `auditedOperation`, and error
 * mapping all live there, shared with `[organisation]/actions.ts`, rather
 * than a second hand-rolled copy — the copy this file used to be is exactly
 * what let a raw `pg` error (`mapDuplicateSuppression` below is the one
 * allowlisted exception to that) and a diverging audit-actor identity reach
 * the operator in the first place.
 */

const ALREADY_ON_LIST_MESSAGE = "That email or Instagram handle is already on the do-not-contact list.";

/**
 * Postgres reports a UNIQUE-index violation with a message naming the
 * constraint (`crm_suppressions_email_uq` / `crm_suppressions_ig_uq`). This
 * is the one database error this surface allowlists — mapped to an
 * operator-facing "already on the list" rather than falling through to the
 * generic "not saved", because it's the one everyday collision the form's
 * own two-key CHECK can't catch client-side (only the database index knows
 * the list's current contents at write time).
 */
function mapDuplicateSuppression(cause: unknown): { ok: false; message: string } | undefined {
  if (
    cause instanceof Error &&
    /duplicate key value violates unique constraint "crm_suppressions_(email|ig)_uq"/.test(
      cause.message,
    )
  ) {
    return { ok: false, message: ALREADY_ON_LIST_MESSAGE };
  }
  return undefined;
}

export interface AddSuppressionActionInput {
  email?: string;
  instagramHandle?: string;
  reason: string;
}

export async function addSuppressionAction(
  input: AddSuppressionActionInput,
): Promise<CrmActionResult> {
  // Trimmed here, not only in the client form: a server action is a
  // network-reachable endpoint in its own right, and the client's `.trim()`
  // is not the boundary that matters.
  const email = input.email?.trim() || undefined;
  const instagramHandle = input.instagramHandle?.trim() || undefined;
  const reason = input.reason.trim();

  if (!email && !instagramHandle) {
    return { ok: false, message: "Enter an email or an Instagram handle." };
  }
  if (!reason) {
    return { ok: false, message: "Enter a reason." };
  }

  const result = await withCrmWrite(
    email ?? instagramHandle ?? "unknown",
    (actor) => addSuppression({ email, instagramHandle, reason, actor: actor.email }),
    () => ({ action: "crm.suppression.add", summary: { added: 1 } }),
    mapDuplicateSuppression,
  );
  if (!result.ok) return result;
  revalidatePath("/platform/crm/suppressions");
  return { ok: true };
}

export async function removeSuppressionAction(id: string): Promise<CrmActionResult> {
  const result = await withCrmWrite(
    // Fallback only: `describe` below supplies the real target once the row
    // is in hand. Used verbatim only if nothing matched and there is no
    // email/handle to report instead (Ruling 20).
    id,
    () => removeSuppression(id),
    (rows) => {
      const removed = rows[0];
      return {
        action: "crm.suppression.remove",
        // Important 3: the real outcome, not an assumption —
        // `removeSuppression` returns exactly the rows its
        // DELETE ... RETURNING reported, so a removal that matched nothing
        // is honestly `{ removed: 0 }`, not a fabricated `{ removed: 1 }`.
        summary: { removed: rows.length },
        // Ruling 20: the suppression key (email or Instagram handle) on
        // both the add and the remove path, not a uuid one and an email the
        // other — #204 already treats this column as deliberately carrying
        // the accountable fact, and a uuid there is unreadable at the exact
        // moment an auditor needs it.
        target: removed?.email ?? removed?.instagramHandle ?? id,
      };
    },
  );
  if (!result.ok) return result;
  revalidatePath("/platform/crm/suppressions");
  return { ok: true };
}
