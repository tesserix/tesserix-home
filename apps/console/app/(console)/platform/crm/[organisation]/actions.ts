"use server";

import { revalidatePath } from "next/cache";
import {
  advanceStage,
  setNextAction,
  logActivity,
  linkConversion as linkConversionRow,
  MissingProductError,
  type AdvanceStageResult,
} from "@/lib/db/crm-repo";
import { withCrmWrite, type CrmActionResult } from "@/lib/crm-write";
import { isCrmStage, isHumanActivityKind, requiresProduct } from "@/lib/crm";

export type { CrmActionResult };

/**
 * `MissingProductError` is the one exception this surface maps to its own
 * message rather than the shared wrapper's generic "not saved": it is
 * already a clear, operator-facing prompt (migration 0021's grandfathered-row
 * case), not a caught database error. Passed to `withCrmWrite` as `mapError`
 * so the allowlisting stays explicit and per-caller, rather than the shared
 * wrapper guessing which exceptions are safe to show.
 */
function mapMissingProduct(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof MissingProductError) {
    return { ok: false, message: cause.message };
  }
  return undefined;
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
    mapMissingProduct,
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
    mapMissingProduct,
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

const LINK_METHODS = ["matched", "manual"] as const;
type LinkMethod = (typeof LINK_METHODS)[number];

function isLinkMethod(value: string): value is LinkMethod {
  return (LINK_METHODS as readonly string[]).includes(value);
}

export interface LinkConversionInput {
  organisationId: string;
  product: string;
  ref: string;
  label?: string;
  method: LinkMethod;
}

/**
 * Link an organisation's won deal to a product's conversion.
 *
 * The email match Task 9's conversion-status client surfaces is a
 * suggestion, never an automatic link (see the handoff view): this action is
 * the one place that suggestion — or a hand-typed entry — becomes a durable
 * write, and it is only ever reached by an explicit operator action, through
 * either path. `method` records which one happened, so a bad match can never
 * be indistinguishable, after the fact, from an operator's own decision.
 *
 * Validated here, before any session or database work — same shape as
 * `changeStage` above — so an incomplete request never reaches the audit
 * trail: there is nothing yet worth accounting for.
 */
export async function linkConversion(input: LinkConversionInput): Promise<CrmActionResult> {
  const product = input.product.trim();
  const ref = input.ref.trim();
  const label = input.label?.trim() || undefined;

  if (!product || !ref) {
    return { ok: false, message: "A product and a reference are required to link a conversion." };
  }
  if (!isLinkMethod(input.method)) {
    return { ok: false, message: `"${input.method}" is not a valid link method.` };
  }

  const method = input.method;
  const result = await withCrmWrite(
    input.organisationId,
    () =>
      linkConversionRow({
        organisationId: input.organisationId,
        product,
        ref,
        label,
        method,
      }),
    (outcome) => ({
      action: "crm.conversion.link",
      summary: { linked: 1 },
      target: outcome.organisationName,
    }),
  );
  if (!result.ok) return result;
  revalidatePath("/platform/crm");
  revalidatePath(`/platform/crm/${input.organisationId}`);
  return { ok: true };
}
