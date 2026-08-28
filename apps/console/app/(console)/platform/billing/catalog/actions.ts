"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import {
  auditedOperation,
  AuditUnavailableError,
  AuditWriteError,
  type AuditDescription,
} from "@/lib/db/audit-repo";
import { createDraftFrom, discardDraft, setDraftAmount } from "@/lib/db/publish-repo";
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import type { StripeMode } from "@/lib/billing/stripe-read";

/**
 * The catalog draft's write path: start a draft, edit an amount in it,
 * discard it. Nothing here calls Stripe — `publish-repo.ts`'s functions are
 * `plan_catalog_revisions` / `plan_catalog_prices` / `plan_catalog_amounts`
 * writes only, and `draft-editor.tsx` is the one client component allowed to
 * import this module (see that file's own comment).
 *
 * # `billing`, not `publish-catalog`
 *
 * A draft changes nothing Stripe has ever seen — publishing (the next task)
 * is the action that talks to Stripe, and `publish-catalog` (added last
 * task) is the verb that gates THAT. Gating a draft edit on it would refuse
 * every operator who can see and reason about the catalog (`billing`) from
 * ever drafting a change for a publisher to review, which is not what either
 * capability is for.
 *
 * # `withDraftWrite`, not `withCrmWrite`
 *
 * Same three-part shape `crm-write.ts`'s `withCrmWrite` established — session
 * check, `checkOperatorCapability`, `auditedOperation`, error mapping — but
 * not a call to it: `withCrmWrite`'s permission copy ("edit the CRM") and its
 * `actor.email` audit identity are CRM-specific, and duplicating the wrapper
 * here (rather than parameterising theirs) keeps this surface's capability
 * and copy independent of a change to CRM's, the same reasoning
 * `tools-write.ts`'s header gives for being a SIBLING of `withCrmWrite`
 * rather than a caller of it.
 */

export type DraftActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

const NO_PERMISSION_MESSAGE = "You don't have permission to edit the plan catalog.";

/**
 * Internal error text (transport/database detail, or a repo function's own
 * business-rule message) must never reach the operator verbatim — the same
 * discipline `withCrmWrite` applies. There is no allowlisted exception type
 * on this surface yet (unlike `mapMissingProduct` et al. in the CRM actions),
 * because none of `publish-repo.ts`'s thrown errors are things an operator
 * of THIS editor can act on: "a draft already exists" and "no published
 * revision to base a draft on" are both refusals a future surface task (not
 * this one) has to render, not this generic write path.
 */
const NOT_SAVED_MESSAGE = "That change was not saved.";

async function withDraftWrite<T>(
  target: string,
  run: (actor: { sub: string }) => Promise<T>,
  describe: (result: T) => AuditDescription,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    checkOperatorCapability(session, "billing");
    const actor = { sub: session?.sub ?? "unknown" };
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
    // `AuditUnavailableError` fires BEFORE the operation runs — nothing
    // happened, so "not saved" is exactly true. `AuditWriteError` fires
    // after a write that already committed; for a single-cell draft edit a
    // retry is harmless (unlike CRM's erasure/delete paths), so the same
    // conservative message is safe here too.
    return { ok: false, message: NOT_SAVED_MESSAGE };
  }
}

const CATALOG_SURFACE_PATH = "/platform/billing/catalog";

/**
 * Start a new draft, copying `mode`'s currently published revision.
 * `createDraftFrom` refuses (loudly, via a thrown `Error` mapped to
 * {@link NOT_SAVED_MESSAGE} above) when a draft already exists or `mode`
 * has never been published — see that function's own doc comment.
 */
export async function startDraftAction(mode: StripeMode): Promise<DraftActionResult> {
  const result = await withDraftWrite(
    mode,
    (actor) => createDraftFrom(mode, actor.sub),
    (revisionId) => ({
      action: "billing.catalog.draft.start",
      summary: { started: 1 },
      target: `${mode} (${revisionId})`,
    }),
  );
  if (!result.ok) return result;
  revalidatePath(CATALOG_SURFACE_PATH);
  return { ok: true };
}

/**
 * Edit one (lookup_key, currency) cell's amount in a draft.
 *
 * Validated here, before any session or database work — same discipline the
 * CRM actions apply (`changeStage`, `linkConversion`): an invalid request
 * never reaches `checkOperatorCapability` or the audit trail, because there
 * is nothing yet worth accounting for. `draft-editor.tsx` already refuses a
 * non-integer or negative amount at the point of edit (see that file's own
 * validation, which exists so the operator sees the refusal immediately
 * rather than after a round trip); this is the SAME rule enforced again at
 * the server boundary, per this codebase's "never trust external data" rule
 * — a caller of this action is not necessarily that editor.
 */
export async function setAmountAction(
  revisionId: string,
  lookupKey: string,
  currency: string,
  minor: number,
): Promise<DraftActionResult> {
  if (!Number.isInteger(minor) || minor <= 0) {
    return { ok: false, message: "Enter a whole number of minor units." };
  }

  const result = await withDraftWrite(
    `${lookupKey} (${currency})`,
    () =>
      setDraftAmount({
        revisionId,
        source: SINGLE_SOURCE,
        lookupKey,
        currency,
        unitAmountMinor: minor,
      }),
    () => ({
      action: "billing.catalog.draft.amount.set",
      summary: { updated: 1 },
      target: `${lookupKey} (${currency})`,
    }),
  );
  if (!result.ok) return result;
  revalidatePath(CATALOG_SURFACE_PATH);
  return { ok: true };
}

/** Discard the draft named by `revisionId` — see `discardDraft`'s own doc
 *  comment for when this refuses (a published revision cannot be discarded). */
export async function discardDraftAction(revisionId: string): Promise<DraftActionResult> {
  const result = await withDraftWrite(
    revisionId,
    () => discardDraft(revisionId),
    () => ({ action: "billing.catalog.draft.discard", summary: { discarded: 1 } }),
  );
  if (!result.ok) return result;
  revalidatePath(CATALOG_SURFACE_PATH);
  return { ok: true };
}
