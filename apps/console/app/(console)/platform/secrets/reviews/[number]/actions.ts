"use server";

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { auditedOperation, type AuditDescription } from "@/lib/db/audit-repo";
import { approveProposal, mergeProposal, rejectProposal } from "@/lib/secrets-api";
import { PlatformApiError } from "@/lib/platform-api-error";
// The type, not a second copy of it: `SecretsWriteResult` is already the
// shape `{ ok: true } | { ok: false; message: string }` this file needs, and
// `access-actions.ts` (Task 3/7) is where it is defined. Importing it keeps
// there being exactly one write-result shape in this console; a locally
// declared lookalike would be a second contract every future caller would
// have to notice is actually the same as the first.
//
// A type-only import, never a re-export: this is a `"use server"` module,
// and `export type { Foo }` is banned here (see
// `lib/server-action-type-export.guard.test.ts`) — Next.js compiles every
// export of a server module into a runtime binding, and a type has none, so
// re-exporting one throws `ReferenceError` at module evaluation. Nothing
// below re-exports this type; every caller that needs it imports it from
// `access-actions.ts` directly, the same file this import points at.
import type { SecretsWriteResult } from "@/app/(console)/platform/secrets/[...path]/access-actions";

/**
 * Approve, merge, and reject a proposal — the review queue's write side.
 *
 * # SAME GATE, SAME AUDITED SHAPE, AS `access-actions.ts`
 *
 * `secrets-api`'s `POST /api/reviews/:number/{approve,merge,reject}` all sit
 * in its `live` route group, requiring `platform` AND `rotate-credentials`
 * together — the identical requirement `access-actions.ts`'s grant/revoke
 * actions gate on, for the identical reason: each of these changes
 * `tesserix-k8s` or the pull request against it immediately, not a value
 * inside an existing store. So this file copies that file's shape exactly —
 * the capability check runs INSIDE `auditedOperation`'s `operation`
 * callback, not before it, so a refusal is recorded as a `capability.refused`
 * row rather than vanishing before the audit path is entered.
 *
 * `withReviewWrite` below is NOT imported from `access-actions.ts` — that
 * file exports no such helper (only its action functions and
 * `SecretsWriteResult`), and it is out of this task's file scope to add one.
 * It is mirrored here instead, the same relationship `access-actions.ts`
 * itself has to `billing/catalog/actions.ts`'s `withDraftWrite`/
 * `withPublishWrite`: one recurring shape, copied at each boundary that
 * needs it, rather than a shared abstraction spanning unrelated features.
 */

const NO_PERMISSION_MESSAGE = "You don't have permission to act on this proposal.";

function isForbidden(cause: unknown): boolean {
  return cause instanceof PlatformApiError && cause.status === 403;
}

async function withReviewWrite<T>(
  target: string,
  run: () => Promise<T>,
  describe: (result: T) => AuditDescription,
  notSavedMessage: string,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    const actor = session?.sub ?? "unknown";
    const value = await auditedOperation({
      actor,
      target,
      operation: async () => {
        await checkOperatorCapabilityLive(session, "platform");
        await checkOperatorCapabilityLive(session, "rotate-credentials");
        return run();
      },
      describe,
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof CapabilityError || isForbidden(cause)) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    // Internal error text — a transport failure, a non-2xx status, a body
    // that was not JSON — is never shown verbatim, same discipline
    // `access-actions.ts`'s `withAccessWrite` applies. `notSavedMessage` is
    // per-call (approve/merge/reject each describe their own failure) rather
    // than one fixed string for all three, because `approveAndMergeAction`
    // below has to be able to tell its caller WHICH of the two calls failed.
    return { ok: false, message: notSavedMessage };
  }
}

/**
 * Approve the proposal, then merge it — one operator action, two GitHub
 * calls and two audit rows, matching `secrets-api`'s own separate
 * `ActionReviewApprove`/`ActionReviewMerge` audit entries
 * (`handlers/reviews.go`).
 *
 * THE TWO CALLS ARE NOT ATOMIC, AND THE RESULT SAYS SO. If `approveProposal`
 * succeeds and `mergeProposal` then fails, the approval is already live on
 * GitHub — it is not rolled back, and cannot be from here. Returning the
 * generic "not saved" message at that point would tell the operator nothing
 * happened, which is false: their approval stands, only the merge did not
 * go through. The failure message says so explicitly rather than leaving
 * that fact for the operator to discover by re-opening the pull request.
 */
export async function approveAndMergeAction(number: number): Promise<SecretsWriteResult> {
  const target = `pull/${number}`;

  const approveResult = await withReviewWrite(
    target,
    () => approveProposal(number),
    () => ({ action: "secrets.review.approve", summary: { approved: 1 }, target }),
    "The approval was not recorded.",
  );
  if (!approveResult.ok) return approveResult;

  const mergeResult = await withReviewWrite(
    target,
    () => mergeProposal(number),
    () => ({ action: "secrets.review.merge", summary: { merged: 1 }, target }),
    "The merge did not go through.",
  );
  if (!mergeResult.ok) {
    return {
      ok: false,
      message: `The approval went through, but the merge did not: ${mergeResult.message} ` +
        "Your approval already stands on GitHub — merging can be retried without approving again.",
    };
  }

  return { ok: true };
}

/**
 * Reject the proposal. No reason travels with this call: the prototype this
 * console absorbed collects none, spec §5 keeps the revoke reason out of
 * scope for this cutover, and `rejectProposal`'s `reason` parameter is
 * optional on the wire for exactly this — `secrets-api`'s handler does
 * `_ = c.ShouldBindJSON(&body)`, so an empty body is a legal request the
 * handler falls back from ("no reason given"), not an error condition this
 * action has to route around.
 */
export async function rejectProposalAction(number: number): Promise<SecretsWriteResult> {
  const target = `pull/${number}`;

  const result = await withReviewWrite(
    target,
    () => rejectProposal(number),
    () => ({ action: "secrets.review.reject", summary: { rejected: 1 }, target }),
    "The rejection was not recorded.",
  );
  if (!result.ok) return result;

  return { ok: true };
}
