"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { addSuppression, removeSuppression } from "@/lib/db/crm-repo";
import { AuditUnavailableError, AuditWriteError } from "@/lib/db/audit-repo";

/**
 * The do-not-contact list's two writes.
 *
 * Not `withCrmWrite` (see `../[organisation]/actions.ts`): that helper calls
 * `auditedOperation` itself around whatever `run` returns, and
 * `removeSuppression` (crm-repo.ts) already does that internally — removal
 * is the consequential direction (it is what re-exposes someone who asked
 * not to be contacted), so it carries its own audit guarantee rather than
 * leaving it to whichever caller happens to invoke it. Wrapping it in
 * `withCrmWrite` too would write two audit rows for one removal. This module
 * still does the same session check and capability gate `withCrmWrite`
 * does — a verb must fail closed on its own rather than inherit safety from
 * routing — it just doesn't audit a second time.
 */

export type SuppressionActionResult = { ok: true } | { ok: false; message: string };

const NO_PERMISSION_MESSAGE = "You don't have permission to edit the do-not-contact list.";
const NOT_SAVED_MESSAGE = "That change was not saved.";

async function requireOperator(): Promise<{ sub: string; email: string }> {
  const session = await getCurrentSession();
  checkOperatorCapability(session, "read");
  return {
    sub: session?.sub ?? "unknown",
    email: session?.email ?? session?.sub ?? "unknown",
  };
}

function mapError(cause: unknown): SuppressionActionResult {
  if (cause instanceof CapabilityError) {
    return { ok: false, message: NO_PERMISSION_MESSAGE };
  }
  if (cause instanceof AuditUnavailableError || cause instanceof AuditWriteError) {
    return { ok: false, message: NOT_SAVED_MESSAGE };
  }
  if (cause instanceof Error) {
    // Validation errors thrown by `addSuppression` before any write (e.g.
    // "requires an email or an instagram handle") are already
    // operator-facing and safe to surface — nothing else this function
    // calls throws a plain `Error` before that point.
    return { ok: false, message: cause.message };
  }
  return { ok: false, message: NOT_SAVED_MESSAGE };
}

export interface AddSuppressionActionInput {
  email?: string;
  instagramHandle?: string;
  reason: string;
}

export async function addSuppressionAction(
  input: AddSuppressionActionInput,
): Promise<SuppressionActionResult> {
  try {
    const actor = await requireOperator();
    await addSuppression({
      email: input.email || undefined,
      instagramHandle: input.instagramHandle || undefined,
      reason: input.reason,
      actor: actor.email,
    });
    revalidatePath("/platform/crm/suppressions");
    return { ok: true };
  } catch (cause) {
    return mapError(cause);
  }
}

export async function removeSuppressionAction(id: string): Promise<SuppressionActionResult> {
  try {
    const actor = await requireOperator();
    await removeSuppression(id, actor.email);
    revalidatePath("/platform/crm/suppressions");
    return { ok: true };
  } catch (cause) {
    return mapError(cause);
  }
}
