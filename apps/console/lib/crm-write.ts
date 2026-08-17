import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import {
  auditedOperation,
  AuditUnavailableError,
  AuditWriteError,
  type AuditDescription,
} from "@/lib/db/audit-repo";

/**
 * The one wrapper every CRM write goes through: session check +
 * `checkOperatorCapability(session, "read")` + `auditedOperation` + error
 * mapping.
 *
 * Ruling 17: originally lived only in `crm/[organisation]/actions.ts`. Task 7
 * added a second CRM surface (the do-not-contact list) that hand-rolled its
 * own copy of the same three things (session check, capability gate, error
 * mapping) rather than sharing this one — and the copy diverged twice within
 * a single review round: it let raw `pg`/audit errors reach the operator
 * (anything that was an `Error` got its `.message` shown verbatim, which
 * covers "duplicate key value violates unique constraint ..." on the very
 * first everyday collision), and it audited under `actor.email` while this
 * wrapper always uses `actor.sub` (the column's documented contract), so
 * `console_audit_log.actor` held two different identity shapes depending on
 * which CRM surface produced the row. Lifting this out — one control, one
 * place — is what makes both mistakes structurally impossible for a second
 * caller to repeat, which a second copy, however carefully written, cannot
 * guarantee.
 */

export type CrmActionResult = { ok: true } | { ok: false; message: string };

const NO_PERMISSION_MESSAGE = "You don't have permission to edit the CRM.";

/**
 * Internal error strings (transport/database detail) must never reach the UI
 * verbatim — surfaced only as this generic, per-verb message. A caller with
 * its own well-known, operator-safe exception (e.g. `MissingProductError`,
 * a duplicate-suppression conflict) maps it explicitly via `mapError`, which
 * runs only after the structural cases below have had a chance to match —
 * `mapError` is an allowlist a caller opts into per exception type, never a
 * blanket "anything that is an Error is safe to show".
 */
const NOT_SAVED_MESSAGE = "That change was not saved.";

/**
 * See the module comment for why this is a Zitadel-role gap rather than a
 * missing capability check: none of the seven `Capability` values fits "edit
 * the CRM pipeline" today, so every CRM write is gated on `read` (console
 * entry — every operator already holds it) and made accountable through
 * `auditedOperation` instead. Closing this properly is one Zitadel role
 * change that covers every CRM surface, not one per surface.
 */
export async function withCrmWrite<T>(
  target: string,
  run: (actor: { sub: string; email: string }) => Promise<T>,
  describe: (result: T) => AuditDescription,
  mapError?: (cause: unknown) => { ok: false; message: string } | undefined,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    checkOperatorCapability(session, "read");
    const actor = {
      sub: session?.sub ?? "unknown",
      email: session?.email ?? session?.sub ?? "unknown",
    };
    const value = await auditedOperation({
      actor: actor.sub,
      target,
      operation: () => run(actor),
      describe,
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    if (cause instanceof AuditUnavailableError || cause instanceof AuditWriteError) {
      return { ok: false, message: NOT_SAVED_MESSAGE };
    }
    const mapped = mapError?.(cause);
    if (mapped) return mapped;
    return { ok: false, message: NOT_SAVED_MESSAGE };
  }
}
