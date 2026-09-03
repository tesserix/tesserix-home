"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import {
  auditedOperation,
  type AuditDescription,
  type AuditableRefusal,
  type AuditSummary,
} from "@/lib/db/audit-repo";
import {
  createDraftFrom,
  discardDraft,
  promotePublication,
  setDraftAmount,
  startPublishAttempt,
} from "@/lib/db/publish-repo";
import { readCatalogAmounts, readRevisionAmounts } from "@/lib/db/plan-catalog-repo";
import { policyFor, SINGLE_SOURCE } from "@/lib/billing/source-policy";
import {
  buildPublishPlan,
  type PublishPlan,
  type PublishPlanCounts,
  type UnactionableDifference,
} from "@/lib/billing/publish-plan";
import { checkGuards, type GuardRule, type GuardVerdict } from "@/lib/billing/publish-guards";
import { executePublish, scopeObserved } from "@/lib/billing/publish-executor";
import { findOrphans, type Orphan } from "@/lib/billing/orphans";
import { stripePriceReader, type StripeMode } from "@/lib/billing/stripe-read";

/**
 * The catalog's write path, in two halves.
 *
 * THE DRAFT half — `startDraftAction`, `setAmountAction`,
 * `discardDraftAction` — calls Stripe not at all: `publish-repo.ts`'s
 * functions are `plan_catalog_revisions` / `plan_catalog_prices` /
 * `plan_catalog_amounts` writes only, and `draft-editor.tsx` is the one
 * client component allowed to import them.
 *
 * THE PUBLISH half — `planPublishAction`, `publishAction` — is the first
 * caller `publish-plan.ts`, `publish-guards.ts` and `publish-executor.ts`
 * have ever had. Before it, all three were inert library code; after it, an
 * operator action creates, replaces and archives real Stripe Prices.
 * `publish-view.tsx` is its one client component.
 *
 * # `billing`, and `publish-catalog` on top of it for publishing
 *
 * A draft changes nothing Stripe has ever seen, so a draft edit is gated on
 * `billing` alone — gating it on `publish-catalog` would refuse every
 * operator who can see and reason about the catalog from ever drafting a
 * change for a publisher to review, which is not what either capability is
 * for. Publishing is the action that talks to Stripe, and `publish-catalog`
 * (a RISK verb, `packages/platform-auth/src/capabilities.ts`) is what gates
 * THAT — checked IN ADDITION to `billing`, never instead of it: the surface
 * is a billing surface, and an operator without `billing` has no business on
 * it whatever else they hold.
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
 * discipline `withCrmWrite` applies.
 */
const NOT_SAVED_MESSAGE = "That change was not saved.";

/**
 * The allowlist T3 deliberately left empty, settled here because THIS task
 * surfaces the path.
 *
 * T3's version of this file said there was nothing an operator of the draft
 * editor could act on, which was true while the editor was the only caller:
 * "a draft already exists" was unreachable from a surface that never started
 * one. `publish-view.tsx` changes that — an operator can now start a draft,
 * publish it, and collide with a second operator doing the same — and
 * "That change was not saved" for a collision the operator could resolve in
 * one click is a message that wastes their time and teaches them the surface
 * is unreliable.
 *
 * MATCHED ON THE THROWING FUNCTION'S OWN PREFIX, and REPLACED, never passed
 * through: each entry names a refusal this codebase raises deliberately (see
 * each function's doc comment in `publish-repo.ts`) and answers it with a
 * sentence written for an operator. The repo's own wording — which carries
 * revision UUIDs, table names and mode strings — is never what is shown. A
 * cause matching nothing here degrades to the conservative default, so a
 * transport error, a constraint violation, or any message a future edit adds
 * cannot leak by omission.
 */
const ACTIONABLE_REFUSALS: readonly { readonly test: RegExp; readonly message: string }[] = [
  {
    test: /^createDraftFrom: a draft already exists/,
    message: "A draft already exists. Open it, or discard it, before starting another.",
  },
  {
    test: /^createDraftFrom: \S+ has no published revision/,
    message: "This mode has never been published, so there is nothing to base a draft on.",
  },
  {
    test: /^(discardDraft|setDraftAmount): revision \S+ is published/,
    message: "That revision is published. A published revision cannot be edited or discarded.",
  },
  {
    test: /^startPublishAttempt: an open publish attempt already exists/,
    message: "A publish is already in progress for this mode. Wait for it to finish before starting another.",
  },
];

function actionableRefusal(cause: unknown): string | null {
  if (!(cause instanceof Error)) return null;
  return ACTIONABLE_REFUSALS.find((entry) => entry.test.test(cause.message))?.message ?? null;
}

async function withDraftWrite<T>(
  target: string,
  run: (actor: { sub: string }) => Promise<T>,
  describe: (result: T) => AuditDescription,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    const actor = { sub: session?.sub ?? "unknown" };
    // The gate runs INSIDE `operation`, not before this call, so a
    // `CapabilityError` reaches `auditedOperation` and is written as a
    // `capability.refused` row (#409) instead of never entering the audit
    // path at all — see `crm-write.ts`'s `withCrmWrite` for the identical
    // change and its full rationale, including the decided consequence for
    // `AuditUnavailableError` (fail closed on auditability: with no
    // database, this check never runs and the caller sees "not saved"
    // rather than "no permission", even when the capability would have
    // been refused). Pinned by actions.test.ts.
    const value = await auditedOperation({
      actor: actor.sub,
      target,
      operation: async () => {
        await checkOperatorCapabilityLive(session, "billing");
        return run(actor);
      },
      describe,
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    // `audit-repo`'s `AuditUnavailableError` fires BEFORE the operation runs
    // — nothing happened, so "not saved" is exactly true. Its
    // `AuditWriteError` fires after a write that already committed; for a
    // single-cell draft edit a retry is harmless (unlike CRM's erasure/delete
    // paths), so the same conservative message is safe here too.
    return { ok: false, message: actionableRefusal(cause) ?? NOT_SAVED_MESSAGE };
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

// ---------------------------------------------------------------------------
// Publishing
//
// Everything below is the write path to STRIPE. See this module's header for
// why it is gated on `publish-catalog` in addition to `billing`.
// ---------------------------------------------------------------------------

/** What `publish-view.tsx` renders. Deliberately NOT the whole
 *  `PublishPlan`: the operations carry Stripe Price ids, and the plan carries
 *  its `fingerprint` — which is recomputed server-side at publish time, so
 *  shipping it to a client that could send a stale one back would be
 *  inventing a way to defeat `executePublish`'s own abort. */
export interface PublishPlanSummary {
  readonly revisionId: string;
  readonly mode: StripeMode;
  readonly counts: PublishPlanCounts;
  readonly unactionable: readonly UnactionableDifference[];
  readonly verdict: GuardVerdict;
}

export type PlanPublishResult =
  | { readonly ok: true; readonly plan: PublishPlanSummary }
  | { readonly ok: false; readonly message: string };

/** The typed-mode gate's value, and the guard rules the operator was shown
 *  when they typed it — see {@link publishAction} on why the second one is
 *  not merely decorative. */
export interface PublishConfirmations {
  readonly typedMode: string;
  readonly acknowledged: readonly GuardRule[];
}

/** One row of the write-ahead operation log, numbered for
 *  `publish-outcome.tsx`'s `PublishOutcomeOperation` — see task 9's mounting
 *  of that component, the first caller that needs the FULL operation list
 *  (not just the failed ones' names, which {@link PublishActionResult}
 *  already carried before task 9 as `failedOperations`). */
export interface PublishActionOperation {
  readonly sequence: number;
  readonly kind: string;
  readonly lookupKey: string | null;
  readonly status: "succeeded" | "failed";
  readonly error: string | null;
}

export type PublishActionResult =
  | {
      readonly ok: true;
      /** The attempt this call opened — `publish-outcome.tsx`'s `attemptId`
       *  prop. Not returned before task 9: nothing mounted that component,
       *  so nothing needed the id past this function's own log write. */
      readonly attemptId: string;
      readonly outcome: "succeeded" | "failed" | "aborted";
      /** Whether `plan_catalog_publications` now names this revision — see
       *  {@link publishAction} on why a PARTIAL success does not promote. */
      readonly promoted: boolean;
      readonly failedOperations: readonly string[];
      /** Every operation the write-ahead log recorded for this attempt, in
       *  `sequence` order — `[]` for `"aborted"`, since `executePublish`
       *  never enters `plan.operations` in that case. See
       *  `publish-outcome.tsx`'s own doc comment on why the FULL list (not
       *  just the failed ones) matters on a `"failed"` outcome. */
      readonly operations: readonly PublishActionOperation[];
      /** `findOrphans(mode)` — run here, automatically, ONLY on a `"failed"`
       *  outcome. `orphans.ts`'s own header: the nightly parity check
       *  structurally cannot see this failure mode (an incomplete
       *  `replace_price` leaves the OLD Price active with no lookup key),
       *  so this is the one place it becomes visible, and the check needs a
       *  live Stripe read this action already has the mode and the
       *  capability to make — `page.tsx` deliberately does not, per its own
       *  "no Stripe" doc comment. */
      readonly orphans: readonly Orphan[];
    }
  | { readonly ok: false; readonly message: string };

const NO_PUBLISH_PERMISSION_MESSAGE = "You don't have permission to publish the plan catalog.";

/**
 * NOT "that publish did not run" — it may have.
 *
 * `auditedOperation` raises `AuditUnavailableError` BEFORE the operation
 * (nothing happened) but `AuditWriteError` AFTER it (the publish ran and the
 * audit row did not land), and this wrapper cannot tell the two apart from
 * the outside. For a draft edit that ambiguity is harmless — a retry rewrites
 * one cell. For a publish it is not: a blind retry opens a second attempt,
 * with new idempotency keys, against a Stripe account that may already hold
 * the writes. So this message never claims nothing happened; it sends the
 * operator to the log that actually knows
 * (`plan_catalog_publish_operations`, 0038).
 */
const PUBLISH_INCOMPLETE_MESSAGE =
  "The publish could not be completed. Check the publish log before retrying — some operations may already have run.";

/**
 * The audit action a refused publish records. Deliberately not
 * `"billing.catalog.publish"` — the successful publish's own action, so a
 * retention or alerting rule keyed on ACTION can tell "this ran" from "this
 * was refused" without parsing `summary` or `target` first (#409).
 */
const PUBLISH_REFUSED_ACTION = "billing.catalog.publish.refused";

/**
 * A refusal this action itself decided, with a message written to be shown
 * verbatim. Distinct from every other throw reaching {@link withPublishWrite},
 * whose text is internal and must not be — see {@link ACTIONABLE_REFUSALS}.
 *
 * `implements AuditableRefusal` (#409, task 2): every one of this action's
 * own refusals is now a decision worth a row, including — especially — a
 * refused LIVE attempt, which is the whole reason this issue exists.
 * `auditRefusal` carries the two facts that make the row findable rather
 * than merely present:
 *
 *   - the ATTEMPTED MODE, so "who tried to publish to live and was refused"
 *     is a query against `summary`, not a grep through free-text `target`.
 *     Worth MORE since #327 P2b, not less: live is now reachable, so the
 *     mode is the difference between a routine event and a billing one.
 *   - WHICH RULE refused it — `currency-coverage`, or an unacknowledged
 *     confirmation naming the guard whose breach the operator never saw
 *     (`mode` among them: a live publish submitted without acknowledging
 *     that it is live refuses here and records `rule_mode`). The two throw
 *     sites in this file therefore produce visibly different rows.
 *
 * No catalog rows or amounts here — `AuditSummary` has nowhere for a row to
 * go (`AuditedOperation.describe`'s own doc comment), and a refusal is not
 * the place to start making room for one. Same shape `refusalDescription`'s
 * `CapabilityError` branch already uses for the identical reason: an
 * identifier-shaped key set to `1`, not a count of anything.
 */
class PublishRefused extends Error implements AuditableRefusal {
  constructor(
    message: string,
    private readonly mode: StripeMode,
    /** Which guard rule(s) produced this refusal — `["mode"]` for the mode
     *  guard, one or more of `checkGuards`' other `GuardRule`s otherwise. */
    private readonly rules: readonly GuardRule[],
  ) {
    super(message);
    this.name = "PublishRefused";
  }

  auditRefusal(): AuditDescription {
    const summary: AuditSummary = {
      [`mode_${this.mode}`]: 1,
      ...Object.fromEntries(
        this.rules.map((rule) => [`rule_${rule.replaceAll("-", "_")}`, 1] as const),
      ),
    };
    return { action: PUBLISH_REFUSED_ACTION, summary };
  }
}

/**
 * Sibling of {@link withDraftWrite}, not a caller of it: two capability
 * checks instead of one, and its own copy for the refusal and the failure —
 * the same reason `tools-write.ts` is a sibling of `withCrmWrite` rather
 * than a parameterisation of it.
 */
async function withPublishWrite<T>(
  target: string,
  run: (actor: { sub: string }) => Promise<T>,
  describe: (result: T) => AuditDescription,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    const actor = { sub: session?.sub ?? "unknown" };
    // BOTH, in this order, and both INSIDE `operation` — see
    // `withDraftWrite`'s identical change just above (and `crm-write.ts`'s
    // `withCrmWrite`) for why: a `CapabilityError` thrown outside
    // `auditedOperation` never reaches `refusalDescription`, so publishing's
    // own capability refusal — the highest-stakes one in this file — used to
    // write nothing. `billing` is still the surface and `publish-catalog`
    // still the risk verb checked in addition to it; only where they run
    // moved.
    const value = await auditedOperation({
      actor: actor.sub,
      target,
      operation: async () => {
        await checkOperatorCapabilityLive(session, "billing");
        await checkOperatorCapabilityLive(session, "publish-catalog");
        return run(actor);
      },
      describe,
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PUBLISH_PERMISSION_MESSAGE };
    }
    if (cause instanceof PublishRefused) {
      return { ok: false, message: cause.message };
    }
    return { ok: false, message: actionableRefusal(cause) ?? PUBLISH_INCOMPLETE_MESSAGE };
  }
}

/**
 * Observe, plan, and judge — the three steps both publish actions need.
 *
 * This is NOT a second copy of `executePublish`'s safety logic. The executor
 * re-observes, rebuilds, compares fingerprints and re-runs the guards on its
 * own, and nothing here weakens or substitutes for that. The plan is built
 * here for one reason the executor cannot supply: `startPublishAttempt`
 * requires a `fingerprint` to open the attempt that `executePublish` then
 * takes as its only argument. `scopeObserved` is IMPORTED from the executor
 * rather than reimplemented for exactly that reason — see its doc comment: a
 * differently-scoped observation produces a different fingerprint, which the
 * executor would then read as "the world moved" and abort on, every time.
 *
 * # EVERY mode is observed, live included (#327 P2b)
 *
 * This used to check the mode rule FIRST and return an empty, never-observed
 * plan for live, to avoid spending a paid `prices.list` call on a mode the
 * guards could not let through whatever it returned. That reasoning ended
 * with the refusal: live is now a CONFIRMATION (`publish-guards.ts`'s
 * `checkMode`), and an operator asked to confirm a publish has to be shown
 * the plan they are confirming — an empty one would be asking them to
 * approve a blank page. Live therefore reads Stripe exactly as test does,
 * and the returned plan carries a real `fingerprint`: the field
 * `startPublishAttempt` requires and the short-circuited path could never
 * honestly supply, which is why that path's plan had to be typed without it
 * (#411's minor 3).
 *
 * What the first live plan will actually say, as of 2026-09-03: nothing.
 * Exactly one catalog revision exists, both modes publish it, and live
 * Stripe already matches it (nightly parity clean, 0 differences, 42
 * prices). Turning live on cannot push a surprise, because there is no draft
 * to push — the first live publish producing an empty plan is the intended
 * shape of it, not a sign something is missing.
 */
async function observeAndPlan(
  mode: StripeMode,
  revisionId: string,
): Promise<{ readonly plan: PublishPlan; readonly verdict: GuardVerdict }> {
  const policy = policyFor(SINGLE_SOURCE);

  const [ancestor, draft, observedRaw] = await Promise.all([
    readCatalogAmounts(mode, SINGLE_SOURCE),
    readRevisionAmounts(revisionId, SINGLE_SOURCE),
    stripePriceReader.listPrices(mode),
  ]);
  const plan = buildPublishPlan({
    ancestor,
    draft,
    observed: scopeObserved(observedRaw, policy.lookupKeyPrefix),
  });
  return { plan, verdict: checkGuards(plan, ancestor, mode) };
}

/**
 * What would publishing `revisionId` to `mode` do? A read: it observes
 * Stripe and builds a plan, and writes nothing anywhere.
 *
 * Gated on `billing` only, and deliberately not audited. It is the same
 * class of act as viewing the catalog — `publish-catalog` gates the write,
 * and requiring the risk verb to so much as LOOK at a plan would stop the
 * operator who is meant to review it before a publisher runs it.
 */
export async function planPublishAction(
  revisionId: string,
  mode: StripeMode,
): Promise<PlanPublishResult> {
  try {
    const session = await getCurrentSession();
    await checkOperatorCapabilityLive(session, "billing");
    const { plan, verdict } = await observeAndPlan(mode, revisionId);
    return {
      ok: true,
      plan: { revisionId, mode, counts: plan.counts, unactionable: plan.unactionable, verdict },
    };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    // A Stripe read failing, a missing key, a database that is not
    // configured — all of them say the same thing to an operator, and none
    // of their text is theirs to read.
    return { ok: false, message: "The publish plan could not be built. Try again shortly." };
  }
}

/**
 * Publish `revisionId` to `mode`: open an attempt, execute it against
 * Stripe, and — on a fully successful outcome — promote the revision so the
 * catalog agrees with what Stripe now holds.
 *
 * # PROMOTION IS PART OF PUBLISHING, and lands with this action
 *
 * `executePublish` never writes a `plan_catalog_publications` row (see its
 * own header, "A SUCCESSFUL PUBLISH IS NOT A PROMOTION").
 * `readCatalogAmounts` joins through that table, so a green publish with no
 * promotion leaves the catalog reading the OLD revision while Stripe holds
 * the NEW one — and 0036 requires a CLEAN parity run to name the publication
 * it checked, so the nightly check goes red by construction and resets the
 * observation window #327's go-live decision is counting. That is why
 * `promotePublication` is called here, in the same change that first gives
 * the executor a caller, and not deferred again.
 *
 * # A PARTIAL SUCCESS DOES NOT PROMOTE
 *
 * `executePublish` continues past a single failed operation and closes the
 * attempt `"failed"` if ANY operation failed — there is no `"partial"`
 * outcome, by design. Promotion is therefore gated on `"succeeded"` and
 * nothing else, which is the safer of the two available readings:
 *
 *   - Promoting a partly-executed plan would make the catalog CLAIM Stripe
 *     matches this revision when it demonstrably does not. The parity check
 *     would go red against a publication asserting the wrong thing, and the
 *     operator's next diff would be computed from an ancestor that was never
 *     really published — a wrong claim written into the record.
 *   - Not promoting leaves the catalog pointing at the previous revision,
 *     which is also not what Stripe holds — but it is a state this system
 *     already understands: parity goes red, the operation log (0038) says
 *     exactly which operations landed, and a NEW attempt re-observes and
 *     re-plans only the remainder. That is precisely the recovery model
 *     `publish-executor.ts`'s header describes.
 *
 * A wrong claim in the record is worse than a known-incomplete one, so the
 * incomplete one is what this returns — and `publish-view.tsx` says so.
 *
 * # What this action does NOT do
 *
 * It does not re-observe, re-plan or re-guard on the executor's behalf. The
 * executor does all three itself, freshly, and aborts on a moved fingerprint
 * or a guard REFUSAL. The guard check below is this surface's own gate on
 * the operator's confirmation, not a substitute for the executor's.
 */
export async function publishAction(
  revisionId: string,
  mode: StripeMode,
  confirmations: PublishConfirmations,
): Promise<PublishActionResult> {
  // Validated before any session or Stripe work, same discipline
  // `setAmountAction` applies: a request with no typed confirmation is not
  // an authorization question, it is an incomplete request. Trimmed and
  // case-insensitive, matching `publish-view.tsx`'s own gate — enforced
  // again HERE because a caller of this action is not necessarily that view.
  if (confirmations.typedMode.trim().toLowerCase() !== mode) {
    return { ok: false, message: `Type "${mode}" to confirm before publishing.` };
  }

  const result = await withPublishWrite(
    `${mode} (${revisionId})`,
    async (actor) => {
      const { plan, verdict } = await observeAndPlan(mode, revisionId);

      if (!verdict.ok && "refused" in verdict) {
        // Guard messages are written to be shown verbatim — see
        // `GuardBreach.message`'s own doc comment. This is the surface's
        // early, legible refusal; `executePublish` refuses the identical
        // verdict again on its own, and would abort the attempt even if this
        // check were deleted. Since #327 P2b `checkCurrencyCoverage` is the
        // only rule that reaches here — `mode` moved to the confirmation
        // branch below, where a live publish now needs the operator's word
        // rather than a code change.
        throw new PublishRefused(
          `Publishing is refused: ${verdict.refused.map((breach) => breach.message).join(" ")}`,
          mode,
          verdict.refused.map((breach) => breach.rule),
        );
      }
      if (!verdict.ok && "requiresConfirmation" in verdict) {
        const unacknowledged = verdict.requiresConfirmation.filter(
          (breach) => !confirmations.acknowledged.includes(breach.rule),
        );
        // Matched by RULE NAME, and that is the whole of what this check
        // claims: a rule that is breached now and was not shown to the
        // operator when they typed their confirmation refuses the publish.
        //
        // What it does NOT claim, stated because a stronger claim was
        // written here first: it does not detect a CHANGED breach under an
        // already-acknowledged rule. A `magnitude` acknowledgement given for
        // one lookup key at one percentage still matches a `magnitude`
        // breach on a different key at a different percentage. Making that
        // precise would mean acknowledging identified breaches, not rules,
        // which the spec does not ask for — this is defence-in-depth on top
        // of the executor's own fingerprint abort (which covers the plan's
        // CONTENT: the observed Stripe state it was built from), not a
        // complete guarantee that the judgement is unchanged.
        if (unacknowledged.length > 0) {
          throw new PublishRefused(
            `This plan changed since it was reviewed: ${unacknowledged
              .map((breach) => breach.message)
              .join(" ")} Review it again before publishing.`,
            mode,
            unacknowledged.map((breach) => breach.rule),
          );
        }
      }

      // A live publish reaches here — it is a confirmation, and an
      // acknowledged one has passed the check above. `plan.fingerprint` is a
      // real hash over a real observation for every mode now (#327 P2b), so
      // there is no longer a branch where `startPublishAttempt` could be
      // handed an absent or guessed one; `observeAndPlan`'s return type no
      // longer has a shape that omits it (#411's minor 3, resolved by
      // deleting the shape rather than guarding it).
      const attemptId = await startPublishAttempt({
        revisionId,
        mode,
        fingerprint: plan.fingerprint,
        startedBy: actor.sub,
      });

      const outcome = await executePublish(attemptId);

      // ONLY on a fully successful outcome — see this function's doc
      // comment. This is the write 0036's clean-run-names-publication
      // constraint depends on.
      const promoted = outcome.outcome === "succeeded";
      if (promoted) {
        await promotePublication(mode, revisionId, actor.sub);
      }

      // `orphans.ts`'s own header: this failure mode is invisible to the
      // nightly parity check, so it is checked HERE, automatically, the one
      // place task 5's `publish-outcome.tsx` can show it — never on a
      // `"succeeded"` or `"aborted"` attempt, where nothing was left
      // half-done for it to find.
      const orphans = outcome.outcome === "failed" ? await findOrphans(mode) : [];

      return {
        attemptId,
        outcome: outcome.outcome,
        promoted,
        failedOperations: outcome.operations
          .filter((operation) => operation.status === "failed")
          .map((operation) => `${operation.kind} ${operation.lookupKey ?? ""}`.trim()),
        operations: outcome.operations.map((operation, index) => ({
          // `executePublish`'s own `OperationResult` carries no `sequence` —
          // it is reconstructed here from array order, which IS execution
          // order (`publish-executor.ts` appends to `plan.operations` in the
          // same order it executes them).
          sequence: index + 1,
          kind: operation.kind,
          lookupKey: operation.lookupKey,
          status: operation.status,
          error: operation.error ?? null,
        })),
        orphans,
      };
    },
    (value) => ({
      action: "billing.catalog.publish",
      // The counts an auditor needs to answer "what did this publish do":
      // how many operations failed, and whether the catalog was promoted to
      // match Stripe afterwards.
      summary: { failed: value.failedOperations.length, promoted: value.promoted ? 1 : 0 },
      target: `${mode} (${revisionId})`,
    }),
  );

  if (!result.ok) return result;
  revalidatePath(CATALOG_SURFACE_PATH);
  return {
    ok: true,
    attemptId: result.value.attemptId,
    outcome: result.value.outcome,
    promoted: result.value.promoted,
    failedOperations: result.value.failedOperations,
    operations: result.value.operations,
    orphans: result.value.orphans,
  };
}
