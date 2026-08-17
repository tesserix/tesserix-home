"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import {
  advanceStage,
  setNextAction,
  logActivity,
  MissingProductError,
  type AdvanceStageResult,
} from "@/lib/db/crm-repo";
import {
  auditedOperation,
  AuditUnavailableError,
  AuditWriteError,
  type AuditDescription,
} from "@/lib/db/audit-repo";
import { isCrmStage, isHumanActivityKind, requiresProduct } from "@/lib/crm";

export type CrmActionResult = { ok: true } | { ok: false; message: string };

const NO_PERMISSION_MESSAGE = "You don't have permission to edit the CRM.";

// Internal error strings (transport/database detail) must never reach the
// UI verbatim — surfaced only as a generic, per-verb message. The two
// exceptions are `MissingProductError` (already a clear, operator-facing
// prompt) and validation errors this file raises itself before any write.
const NOT_SAVED_MESSAGE = "That change was not saved.";

/**
 * The gap this module ships with, deliberately, rather than silently:
 *
 * None of the seven `Capability` values fits "edit the CRM pipeline" —
 * `respond` is documented as "reply to tickets and chats, transition their
 * status", and broadening it to mean "transition anything" would silently
 * hand every support operator write access to the sales pipeline, which is
 * exactly the separation the capability set exists to express. Adding a new
 * capability is a Zitadel role change, out of scope for this task — the
 * bulk-import spec hit the identical wall and recorded the same choice: gate
 * on `read` (console entry — every operator already holds it) and make every
 * write accountable through `auditedOperation` instead. Closing this
 * properly is ONE Zitadel role change that covers import and CRM writes
 * together, not two separate ones.
 *
 * So: this still calls `checkOperatorCapability` — not to distinguish who
 * may write from who may not (today, everyone with console access may), but
 * because a verb must fail closed on its own rather than inherit safety from
 * routing, and because a session must exist at all before `actor` is used
 * for the audit row below.
 */

/**
 * Ruling 15: this is `auditedOperation` (audit-repo.ts) plus a session
 * check and error mapping — nothing more. It used to reimplement
 * `auditedOperation`'s guarantee by hand, on the theory that a dynamic audit
 * `action` needed a different control. It didn't: `AuditedOperation.describe`
 * already takes the operation's *result* and returns `{ action, summary }`
 * together, which is exactly what `changeStage` needs (whether the write was
 * a real stage transition or only a product correction on an unchanged stage
 * isn't known until `advanceStage` has run). A hand-rolled copy in a leaf
 * file — even a faithful one — is a second place the one structural control
 * in this codebase can drift from what the shared module actually enforces.
 */
async function withCrmWrite<T>(
  target: string,
  run: (actor: { sub: string; email: string }) => Promise<T>,
  describe: (result: T) => AuditDescription,
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
    if (cause instanceof MissingProductError) {
      // A clear, operator-facing prompt, not a caught database error — this
      // is exactly the case migration 0021 flagged as Task 6's problem to
      // handle deliberately.
      return { ok: false, message: cause.message };
    }
    return { ok: false, message: NOT_SAVED_MESSAGE };
  }
}

export interface ChangeStageInput {
  organisationId: string;
  opportunityId: string;
  to: string;
  product?: string;
  lostReason?: string;
}

/**
 * Move an opportunity to a new stage (or, for a grandfathered row, supply
 * the product it's missing without moving the stage at all — see
 * `advanceStage` in crm-repo.ts for why that's the same code path).
 *
 * Validated here, before any session or database work, so an invalid
 * request never reaches `checkOperatorCapability` or the audit trail: there
 * is nothing yet worth accounting for.
 */
export async function changeStage(input: ChangeStageInput): Promise<CrmActionResult> {
  if (!isCrmStage(input.to)) {
    return { ok: false, message: `"${input.to}" is not a CRM stage.` };
  }
  if (requiresProduct(input.to) && !input.product) {
    return { ok: false, message: `Moving to "${input.to}" requires a product.` };
  }
  if (input.to === "lost" && !input.lostReason) {
    return { ok: false, message: `Marking an opportunity "lost" requires a reason.` };
  }

  const to = input.to;
  const result = await withCrmWrite(
    input.opportunityId,
    (actor) =>
      advanceStage({
        opportunityId: input.opportunityId,
        to,
        actor: actor.email,
        product: input.product,
        lostReason: input.lostReason,
      }),
    (outcome: AdvanceStageResult) => {
      // A real transition, however it arrived, is `crm.stage.change` — even
      // one that also happened to set the product for the first time. Only
      // a write that touched product WITHOUT moving the stage gets its own
      // action: that's the case an audit reader must be able to tell apart
      // from a transition, because nothing about the pipeline moved.
      if (outcome.stageChanged) {
        return { action: "crm.stage.change", summary: { transitions: 1 } };
      }
      if (outcome.productChanged) {
        return { action: "crm.product.set", summary: { transitions: 0 } };
      }
      // The no-op case: `{ transitions: 0 }` is a valid, honest summary —
      // not a sentinel meaning "something went wrong".
      return { action: "crm.stage.change", summary: { transitions: 0 } };
    },
  );
  if (!result.ok) return result;
  revalidatePath(`/platform/crm/${input.organisationId}`);
  return { ok: true };
}

export interface ScheduleNextActionInput {
  organisationId: string;
  opportunityId: string;
  at: string | null;
  note: string | null;
}

export async function scheduleNextAction(
  input: ScheduleNextActionInput,
): Promise<CrmActionResult> {
  const result = await withCrmWrite(
    input.opportunityId,
    (actor) =>
      setNextAction({
        opportunityId: input.opportunityId,
        at: input.at,
        note: input.note,
        actor: actor.email,
      }),
    () => ({ action: "crm.next_action.set", summary: { scheduled: 1 } }),
  );
  if (!result.ok) return result;
  revalidatePath(`/platform/crm/${input.organisationId}`);
  return { ok: true };
}

export interface AddActivityInput {
  organisationId: string;
  opportunityId?: string;
  kind: string;
  body?: string;
}

/**
 * Log a human-authored activity — a note, a call, a message sent or
 * received. NOT `stage_change` or `assigned`: those are system-authored,
 * written only by the code that performs the thing they describe
 * (`advanceStage`, an owner-assignment write), inside the same transaction
 * as that change. `isHumanActivityKind` — not `isCrmActivityKind` — is the
 * gate here specifically so this action can never forge a `stage_change`
 * row: an arbitrary body claiming a transition, with no stage having moved,
 * is exactly the corruption `advanceStage`'s one-transaction guarantee
 * exists to prevent, and a permissive kind check here would let this action
 * cause it from the other direction.
 */
export async function addActivity(input: AddActivityInput): Promise<CrmActionResult> {
  if (!isHumanActivityKind(input.kind)) {
    return { ok: false, message: `"${input.kind}" is not an activity kind an operator can log directly.` };
  }

  const kind = input.kind;
  const result = await withCrmWrite(
    input.opportunityId ?? input.organisationId,
    (actor) =>
      logActivity({
        organisationId: input.organisationId,
        opportunityId: input.opportunityId,
        kind,
        actor: actor.email,
        body: input.body,
      }),
    () => ({ action: "crm.activity.log", summary: { logged: 1 } }),
  );
  if (!result.ok) return result;
  revalidatePath(`/platform/crm/${input.organisationId}`);
  return { ok: true };
}
