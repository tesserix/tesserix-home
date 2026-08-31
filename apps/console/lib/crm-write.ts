import {
  CapabilityError,
  getCurrentSession,
  type Capability,
} from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import {
  auditedOperation,
  AuditUnavailableError,
  AuditWriteError,
  type AuditDescription,
} from "@/lib/db/audit-repo";

/**
 * The one wrapper every CRM write goes through: session check +
 * `checkOperatorCapabilityLive(session, options.capability)` +
 * `auditedOperation` + error mapping. Defaults to `"read"` because that is
 * the only gate an edit can be checked against today — see the comment on
 * `withCrmWrite` for the one exception (erasure, gated on `hard-delete`)
 * and why the default leaves every other caller unchanged.
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
 * capability check. #261 closed it: `crm` is the surface capability every CRM
 * write now requires, and `read` is back to meaning console entry alone.
 *
 * `capability` is REQUIRED, with no default. It used to default to `read`,
 * which meant a new caller inherited the weakest gate in the system by saying
 * nothing — the exact mechanism that put 11 of 14 mutating actions on the
 * console entry ticket. Making it required turns "which capability does this
 * write need?" into a question the compiler asks.
 *
 * Verbs remain orthogonal: erasure passes `hard-delete`, and it does so IN
 * ADDITION to the caller already living on a CRM surface. Holding `crm` does
 * not confer the right to erase.
 */
export async function withCrmWrite<T>(
  target: string,
  // Second, not last, and required. The gate belongs beside the thing being
  // written — before the work, where a reader meets it — rather than trailing
  // after two callbacks where it reads as configuration. A required parameter
  // also cannot follow the optional `mapError`, which is the compiler making
  // the same point.
  options: { capability: Capability },
  run: (actor: { sub: string; email: string }) => Promise<T>,
  describe: (result: T) => AuditDescription,
  mapError?: (cause: unknown) => { ok: false; message: string } | undefined,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    const actor = {
      sub: session?.sub ?? "unknown",
      email: session?.email ?? session?.sub ?? "unknown",
    };
    // The gate is INSIDE `operation`, not before this call, so it is still
    // "before the work, where a reader meets it" (the comment on the
    // parameter above), but now runs on `auditedOperation`'s own path: a
    // `CapabilityError` thrown here is caught by `auditedOperation`,
    // recognised by `refusalDescription` (#409), and written as a
    // `capability.refused` row before being rethrown unchanged. Checking it
    // OUTSIDE, as before, meant the throw never reached `auditedOperation`
    // at all — a deliberate refusal indistinguishable, on paper, from a
    // request that was simply never made. See `audit-repo.ts`'s
    // `refusalDescription` for the other half of this fix.
    //
    // CONSEQUENCE, decided rather than accidental: `auditedOperation` checks
    // `isDatabaseConfigured()` before running `operation` at all, so with no
    // database configured this capability check now never runs, and the
    // caller sees `AuditUnavailableError` (mapped below to
    // `NOT_SAVED_MESSAGE`) instead of `CapabilityError` (mapped to
    // `NO_PERMISSION_MESSAGE`) even when the capability would have been
    // refused. That is fail-closed on auditability, which is the right
    // default for the exact gap #409 exists to close: an unaudited capability
    // refusal is worse than a generic "not saved" that sends the operator
    // to check back later — and "you don't have permission" would also be
    // wrong to show, since the permission check never actually ran. Pinned
    // by crm-write.test.ts.
    const value = await auditedOperation({
      actor: actor.sub,
      target,
      operation: async () => {
        await checkOperatorCapabilityLive(session, options.capability);
        return run(actor);
      },
      describe,
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    // `AuditUnavailableError` is checked BEFORE the operation runs
    // (`auditedOperation`), so nothing happened and "not saved" is exactly
    // true. `AuditWriteError` is the opposite: the operation already ran and
    // committed, and only the audit row failed. For most CRM writes "not
    // saved" is still the safer thing to tell an operator — they will retry
    // one stage change, and a retry is harmless. For a write that created
    // hundreds of rows it is a lie with consequences, so a caller may map it
    // to something honest. `mapError` gets first refusal on it and this
    // wrapper keeps the conservative default for everyone who doesn't.
    if (cause instanceof AuditUnavailableError) {
      return { ok: false, message: NOT_SAVED_MESSAGE };
    }
    const mapped = mapError?.(cause);
    if (mapped) return mapped;
    if (cause instanceof AuditWriteError) {
      return { ok: false, message: NOT_SAVED_MESSAGE };
    }
    return { ok: false, message: NOT_SAVED_MESSAGE };
  }
}
