/**
 * The CRM organisation-detail writes: stage transitions, scheduling the next
 * action, and logging an activity note.
 *
 * Split out of `crm-repo.ts` (#566); `crm-repo.ts` re-exports everything here,
 * so nothing importing `@/lib/db/crm-repo` had to change.
 */
import { tesserixTx, type TxQuery } from "./tesserix";
import {
  requiresProduct,
  CONTACT_ACTIVITY_KINDS,
  isOutboundActivityKind,
  type CrmActivityKind,
  type CrmStage,
} from "../crm";
import { CLOCK_ELIGIBLE_SQL, nextActionAssignment } from "./crm-sql";
import { isSuppressed } from "./crm-suppressions-repo";

/**
 * The organisation-detail writes: stage transitions, scheduling the next
 * action, and logging an activity note. See migration 0021's header for
 * the constraint every write here has to respect.
 */

/**
 * Thrown when a write targets a "grandfathered" opportunity — one migration
 * 0021 left sitting at `qualified`/`won`/`lost` with a null `product` (the
 * ~155 rows `NOT VALID` grandfathered past the CHECK's initial scan) — and
 * the caller has no product to supply to fix it.
 *
 * `crm_opp_product_required_when_qualified` is `NOT VALID`, which only skips
 * the constraint's initial validation scan; Postgres still evaluates it on
 * the NEW ROW VERSION of every subsequent UPDATE, including a bare
 * `updated_at = now()`. So a grandfathered row is effectively read-only
 * until a product is supplied. This is thrown *before* that UPDATE runs, so
 * the operator sees a clear, typed prompt instead of a raw Postgres
 * constraint-violation error surfacing through the stack.
 */
export class MissingProductError extends Error {
  constructor(readonly opportunityId: string) {
    super(
      `Opportunity ${opportunityId} was migrated without a product and must be assigned one (via a stage update) before it can be edited.`,
    );
    this.name = "MissingProductError";
  }
}

/**
 * Thrown when a write tries to move a VOIDED deal (#251).
 *
 * A void says the deal should never have been in the funnel. Every read in
 * this module now excludes one, so a voided deal cannot be reached from Due,
 * Drifting, Closed or the handoff queue — but `organisationDetail` keeps it,
 * deliberately, because that page is the organisation's file and the restore
 * control has to hang off something. So the detail page is a live surface
 * showing a row whose stage and next-action controls must not fire, and this
 * is what they raise instead.
 *
 * Two writes need it, and they share ONE error type rather than declaring one
 * each. The refusal is the same fact about the same row — this deal is out of
 * the funnel — and the remedy is the same single action: restore it, then
 * make the edit. Two types would put that one fact in two places that can
 * stop agreeing in a single commit, and would oblige every surface that
 * renders it to learn both; the shape of the failure, not the name of the
 * function that hit it, is what a caller branches on. Which write was
 * attempted is already in the caller's own frame.
 *
 * The refusals are TYPED and not silent no-ops. A no-op would report success
 * for a stage move that did not happen, which is the one thing
 * `advanceStageOnQuery`'s whole design refuses to allow — its `AdvanceStageResult`
 * exists precisely so a caller can never assume a write occurred.
 */
export class VoidedOpportunityError extends Error {
  constructor(readonly opportunityId: string) {
    super(
      `Opportunity ${opportunityId} is voided and cannot be edited. Restore it first.`,
    );
    this.name = "VoidedOpportunityError";
  }
}

export interface AdvanceStageInput {
  opportunityId: string;
  to: CrmStage;
  actor: string;
  /** Required whenever `requiresProduct(to)` is true — even if the row
   *  already carries a product from an earlier transition. The caller
   *  supplies it explicitly every time rather than this function silently
   *  reusing whatever is already on the row, so a UI can pre-fill it but an
   *  operator always makes (or confirms) the choice. */
  product?: string;
  /** Required when `to` is "lost". */
  lostReason?: string;
}

/** What actually happened, so a caller (the audit/action layer) can name
 *  and count the write honestly instead of assuming a transition occurred.
 *  `{ stageChanged: false, productChanged: false }` is the no-op case — a
 *  valid, zero-effect outcome, not an error. */
export interface AdvanceStageResult {
  stageChanged: boolean;
  productChanged: boolean;
}

const TERMINAL_STAGES: readonly CrmStage[] = ["won", "lost"];

function isTerminal(stage: CrmStage): boolean {
  return (TERMINAL_STAGES as readonly string[]).includes(stage);
}

/**
 * Advance (or otherwise edit) an opportunity's stage.
 *
 * The rule this function exists to encode: **every stage transition writes
 * a `stage_change` activity, in the same transaction as the stage update,
 * without exception.** It is the only record of when a stage was entered —
 * unreconstructable after the fact — and therefore the only thing that
 * makes funnel measurement possible later. A stage that moved without its
 * activity is the failure this design cannot tolerate, so both writes go
 * through `tesserixTx` on one client: either both land or neither does.
 *
 * The statements themselves live in `advanceStageOnQuery`; this function is
 * that plus a transaction. The split exists so a caller that already holds
 * one can honour this rule instead of copying it — see that function.
 *
 * A same-stage call is not a transition (guards the guard: logging one
 * unconditionally would fill the timeline with noise and undermine the one
 * thing `stage_change` exists to make trustworthy) — UNLESS it also changes
 * `product`, which is the escape hatch for a grandfathered row: an operator
 * can supply the missing product without moving the stage, and that write
 * goes through (no CHECK violation, since the new row still satisfies
 * `stage IN ('new','contacted') OR product IS NOT NULL`). That write still
 * gets its own activity — a product moving underneath a live deal, silently,
 * is exactly the kind of change the timeline exists to catch — just not a
 * `stage_change` one, because no stage actually changed.
 *
 * Ruling 14: a reverse transition (e.g. `lost` → `qualified`) is ALLOWED,
 * not rejected — mis-marking a deal lost is ordinary human error, and
 * refusing the correction would force a hand-written database fix for a
 * mistake the UI itself permitted. But `closed_at`/`lost_reason` describe
 * the stage being left, not carried baggage: they are recomputed from `to`
 * on every stage change, not only ever added. Leaving a re-opened deal with
 * a stale close date and loss reason would corrupt close-rate and
 * cycle-time reads exactly the way an unlogged transition corrupts the
 * funnel — the design treats a returning business as a NEW opportunity, so
 * this reverse path is a correction, not the normal flow, but the record it
 * leaves must still be honest.
 */
export async function advanceStage(input: AdvanceStageInput): Promise<AdvanceStageResult> {
  // Before `tesserixTx`, not inside it: see `assertAdvanceStageInput`.
  assertAdvanceStageInput(input);

  return tesserixTx((query) => advanceStageOnQuery(query, input));
}

/**
 * Advance a stage on a transaction the CALLER already opened.
 *
 * Exported, and this is the whole reason it exists: `tesserixTx` does not
 * nest, so a caller that must do its own writes in the SAME transaction as
 * the stage move (`crm-outreach.ts`, logging a templated DM and moving the
 * lead `new` -> `contacted` as one unit) cannot call `advanceStage` — that
 * function opens a transaction of its own. Such a caller had exactly two
 * options: reimplement the stage UPDATE and its `stage_change` INSERT, or
 * be handed them. A reimplementation is a second copy of the rule that
 * every transition writes its activity, and a second copy is a copy that
 * can stop agreeing with the first in one commit — the `crm-identity.ts`
 * normalisation lesson, where the same rule living in two places is how the
 * two ended up disagreeing about what a handle is. Handing the logic out is
 * what keeps one rule in one place.
 *
 * So: DO NOT write the stage UPDATE by hand anywhere else, and do not reach
 * for this from an action or a barrel export. It is for callers already
 * holding a `TxQuery`, and it carries the atomicity guarantee only because
 * the caller's transaction supplies it.
 *
 * The rules this encodes, the reasons for each, and Ruling 14 are all
 * documented on `advanceStage` above, which is now just this function plus
 * a transaction.
 */
export async function advanceStageOnQuery(
  query: TxQuery,
  input: AdvanceStageInput,
): Promise<AdvanceStageResult> {
  const { opportunityId, to, actor, product, lostReason } = input;

  // Re-checked here and not only in `advanceStage`, because this function is
  // reachable without going through it: a guard the second caller can skip
  // is not a guard. `assertAdvanceStageInput` is pure, so paying for it
  // twice on the `advanceStage` path costs nothing.
  assertAdvanceStageInput(input);

  const rows = await query<{
    stage: CrmStage;
    organisation_id: string;
    product: string | null;
    voided_at: string | null;
  }>(
    `SELECT stage, organisation_id, product, voided_at
       FROM crm_opportunities
      WHERE id = $1
        FOR UPDATE`,
    [opportunityId],
  );
  const current = rows[0];
  if (!current) {
    throw new Error(`advanceStage: opportunity ${opportunityId} not found`);
  }
  // Read from the same locked row as everything below, so no concurrent void
  // can land between the check and the UPDATE (#251).
  //
  // A voided deal does not move. "Void it, then someone moves it to won"
  // would produce a won-and-voided row, and every predicate this module just
  // gained would then have to reconcile a stage that says the deal closed
  // with a column that says it never happened. Worse, `advanceStage` writes
  // `closed_at` and a `stage_change` activity on that transition — the
  // funnel's own source of truth — so the contradiction would not stay in
  // one row. Refusing here is the cheapest place to keep the two consistent.
  //
  // Reachable in practice: `organisationDetail` deliberately keeps voided
  // deals visible, so the stage control is on screen for one.
  if (current.voided_at !== null) {
    throw new VoidedOpportunityError(opportunityId);
  }

  const stageChanging = current.stage !== to;
  const productChanging = product !== undefined && product !== current.product;

  if (!stageChanging && !productChanging) {
    return { stageChanged: false, productChanged: false };
  }

  const setClauses = ["updated_at = now()"];
  const params: unknown[] = [opportunityId];
  if (stageChanging) {
    params.push(to);
    setClauses.push(`stage = $${params.length}`);
    // Recomputed from `to`, not conditionally appended: entering a
    // terminal stage sets these, but LEAVING one (Ruling 14's reverse
    // transition) must clear them just as deliberately, or a corrected
    // "lost" deal keeps its close date and reason forever.
    setClauses.push(isTerminal(to) ? "closed_at = now()" : "closed_at = NULL");
    params.push(to === "lost" ? lostReason : null);
    setClauses.push(`lost_reason = $${params.length}`);
  }
  if (productChanging) {
    params.push(product);
    setClauses.push(`product = $${params.length}`);
  }

  await query(
    `UPDATE crm_opportunities SET ${setClauses.join(", ")} WHERE id = $1`,
    params,
  );

  if (stageChanging) {
    await query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata)
       VALUES ($1, $2, 'stage_change', $3, $4, $5::jsonb)`,
      [
        current.organisation_id,
        opportunityId,
        actor,
        `${current.stage} → ${to}`,
        JSON.stringify({ from: current.stage, to }),
      ],
    );
  } else if (productChanging) {
    // Not a stage_change — the timeline's audience needs to be able to
    // tell "the deal moved" from "someone re-pointed it to a different
    // product without moving it" apart, which is exactly what a shared
    // activity kind would erase.
    await query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata)
       VALUES ($1, $2, 'note', $3, $4, $5::jsonb)`,
      [
        current.organisation_id,
        opportunityId,
        actor,
        `Product set to ${product} (was ${current.product ?? "none"})`,
        JSON.stringify({ productFrom: current.product, productTo: product }),
      ],
    );
  }

  return { stageChanged: stageChanging, productChanged: productChanging };
}

/**
 * Argument-only preconditions for a stage move.
 *
 * Split out so `advanceStage` can run them BEFORE it opens a transaction —
 * an invalid argument then costs no BEGIN/ROLLBACK, which is the property
 * `crm-repo.write.integration.test.ts` names when it says the row is
 * untouched "not because of a rollback but because nothing was ever sent".
 */
function assertAdvanceStageInput(input: AdvanceStageInput): void {
  const { to, product, lostReason } = input;
  // Validated against the argument alone, before any row is read: a
  // transition into a product-required stage always needs the caller to
  // supply one, so this fails fast without a wasted round trip either way.
  if (requiresProduct(to) && !product) {
    throw new Error(`advanceStage: moving to "${to}" requires a product`);
  }
  if (to === "lost" && !lostReason) {
    throw new Error('advanceStage: moving to "lost" requires a lostReason');
  }
}

export interface SetNextActionInput {
  opportunityId: string;
  at: string | null;
  note: string | null;
  actor: string;
}

/**
 * Schedule (or clear) an opportunity's next action.
 *
 * Reads the current row first, inside the same transaction as the UPDATE,
 * specifically to catch the grandfathered-row case: this function has no
 * `product` argument to offer, so if the row needs one and doesn't have
 * one, there is no way for this call to satisfy the CHECK. Refusing here
 * with `MissingProductError` — before the UPDATE runs — is the difference
 * between a clear prompt and a raw constraint-violation error reaching the
 * operator. crm_opportunities has no `updated_at` trigger, so the write
 * sets it explicitly.
 *
 * That same read now also refuses a VOIDED deal, with
 * `VoidedOpportunityError` — see the guard itself for why the queue's own
 * exclusion is not enough.
 */
export async function setNextAction(input: SetNextActionInput): Promise<void> {
  // `actor` is part of the interface for parity with `advanceStage` and
  // `logActivity`, and so a caller has it in hand for the audit row the
  // action layer writes — but this function itself only ever touches
  // `crm_opportunities`, so it isn't threaded through here.
  const { opportunityId, at, note } = input;

  await tesserixTx(async (query) => {
    const rows = await query<{
      stage: CrmStage;
      product: string | null;
      voided_at: string | null;
    }>(
      `SELECT stage, product, voided_at FROM crm_opportunities WHERE id = $1 FOR UPDATE`,
      [opportunityId],
    );
    const current = rows[0];
    if (!current) {
      throw new Error(`setNextAction: opportunity ${opportunityId} not found`);
    }
    // From the same locked read as the product guard below, and ahead of it:
    // a voided deal is refused whether or not it also lacks a product, and
    // "restore it first" is the one instruction that applies to both.
    //
    // Without this, scheduling a next action on a voided deal would succeed
    // and write `next_action_at`. `dueOpportunities` would still hide the
    // row, so nothing visible would break HERE — but the column itself would
    // then say "this is due" about a deal declared never to have happened,
    // and it is read by more than this query: `organisationDetail` renders
    // it, and the platform-API implementation of the same queues has no void
    // predicate yet (T6). A queue filter hides that state; it does not stop
    // it being written (#251).
    if (current.voided_at !== null) {
      throw new VoidedOpportunityError(opportunityId);
    }
    if (requiresProduct(current.stage) && !current.product) {
      throw new MissingProductError(opportunityId);
    }

    await query(
      `UPDATE crm_opportunities
          SET next_action_at = $2, next_action_note = $3, updated_at = now()
        WHERE id = $1`,
      [opportunityId, at, note],
    );
  });
}

export interface LogActivityInput {
  organisationId: string;
  opportunityId?: string;
  kind: CrmActivityKind;
  actor: string;
  body?: string;
}

/** The kinds that count as contact, and why those — `lib/crm.ts`, which
 *  holds the list so the composer and this write path can never disagree
 *  about what "contact" means. A Set only for the membership test below. */
const CONTACT_KIND_SET: ReadonlySet<CrmActivityKind> = new Set(CONTACT_ACTIVITY_KINDS);

/**
 * Thrown when the do-not-contact list refuses a write. design.md:224 says the
 * list is checked "at import and when logging outreach"; before this, only
 * the two import callers checked, so half of what the feature claims was
 * absent. An allowlisted, operator-facing exception (see `mapError` in
 * `lib/crm-write.ts`) rather than a generic failure: an operator who just
 * hit this needs to know WHY, or they will simply try again.
 *
 * `organisationId` is optional and `message` overridable because the same
 * refusal now has two shapes. Outreach is refused against a known
 * organisation; a MANUAL CREATE (`crm-writes.ts`) is refused for a person who
 * asked not to be contacted, and on the new-organisation path there is no
 * organisation id yet — the whole point is that the row does not get written.
 * The message says which of the two happened, and neither wording names any
 * detail the operator did not just type in themselves.
 */
export class SuppressedContactError extends Error {
  constructor(
    readonly organisationId?: string,
    message = "This organisation is on the do-not-contact list. Remove the suppression before logging outreach.",
  ) {
    super(message);
    this.name = "SuppressedContactError";
  }
}

/**
 * Log a note/call/message activity, independent of any stage change.
 *
 * `crm_activities` carries no CHECK tying it to `crm_opportunities.product`
 * — the grandfathered-row constraint (migration 0021) applies only to
 * `crm_opportunities` — so this needs no product guard.
 *
 * It does need a transaction, for two reasons this function did not have
 * before:
 *
 * (1) Suppression (design.md:224). Outbound kinds are refused if any of the
 *     organisation's contacts is suppressed — read on the transaction's own
 *     client, so the check and the insert cannot straddle a concurrent
 *     suppression being added.
 * (2) The queue clocks. `last_contacted_at` was written by NOTHING in the
 *     application — only the migration set it — so logging a DM or a call
 *     left the queue still reporting the organisation as quiet since
 *     whenever the backfill said. `next_action_at` then had the opposite
 *     problem (#502): still unwritten here, and because null IS the drifting
 *     predicate, a contacted lead was filed as drifting by the very act of
 *     contacting it. The activity row and the timestamps it implies must land
 *     together or not at all; a logged call with a stale "quiet since", or one
 *     with no follow-up, is worse than either alone. Which deals they move
 *     for — and why an activity naming no deal moves them for all of the open
 *     ones — is `advanceContactClock` below.
 *
 * `updated_at` is set explicitly. There are no triggers on these tables.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  await tesserixTx(async (query) => {
    // `isOutboundActivityKind` (lib/crm.ts) rather than a list held here.
    // The do-not-contact gate and the follow-up clock below both need to know
    // which kinds are us reaching out, and one list is the only way they can
    // never disagree about it — see that constant's comment for why `call` is
    // on it.
    if (isOutboundActivityKind(input.kind)) {
      await assertNoSuppressedContact(input.organisationId, query);
    }

    await query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.organisationId,
        input.opportunityId ?? null,
        input.kind,
        input.actor,
        input.body ?? null,
      ],
    );

    if (CONTACT_KIND_SET.has(input.kind)) {
      await advanceContactClock(input, query);
    }
  });
}

/**
 * Refuse an outbound kind if anyone at this organisation is on the
 * do-not-contact list. Read on the transaction's own client so the check and
 * the insert cannot straddle a concurrent suppression being added.
 *
 * Exported for the same reason as `advanceStageOnQuery`: "outbound contact is
 * refused for a suppressed organisation" is a rule this file owns, and a
 * second caller that needs it inside its own transaction (`crm-outreach.ts`,
 * re-checking at commit what the preview could only promise about an older
 * state) could either reimplement it or be handed it. Reimplementing means
 * two copies of what counts as suppressed, and the copy that drifts is the
 * one that lets a message reach someone who asked us to stop. It already
 * takes a `query`, so handing it out costs nothing but the `export`.
 */
export async function assertNoSuppressedContact(
  organisationId: string,
  query: TxQuery,
): Promise<void> {
  const contacts = await query<{ email: string | null; instagram_handle: string | null }>(
    `SELECT email, instagram_handle FROM crm_contacts WHERE organisation_id = $1`,
    [organisationId],
  );
  for (const contact of contacts) {
    const suppressed = await isSuppressed(
      {
        email: contact.email ?? undefined,
        instagramHandle: contact.instagram_handle ?? undefined,
      },
      query,
    );
    if (suppressed) {
      throw new SuppressedContactError(organisationId);
    }
  }
}

/**
 * Move both queue clocks — `last_contacted_at`, which Drifting reads, and
 * `next_action_at`, which decides whether the lead is in Drifting at all — for
 * the deals this contact event actually touched.
 *
 * What each kind does to `next_action_at` is `nextActionAssignment` below;
 * this function's own subject is WHICH DEALS.
 *
 * WHICH DEALS, AND WHY THIS REVERSES WHAT THIS FUNCTION USED TO SAY (#245).
 * The previous comment here reasoned that an organisation-level activity
 * "has no one deal whose clock it would be honest to reset", and so reset
 * none. The premise is right and the conclusion was wrong: there is no
 * single deal, but the honest answer is that the event touched ALL of the
 * ones still in play, not none of them. A call to the business is contact
 * with the business, whichever deal the operator had in mind. Resetting
 * none made the console physically unable to write this column — the
 * composer names no deal — so every imported organisation entered Drifting
 * 14 days after import and stayed there for ever, and the queue came to
 * mean "imported a while ago" rather than "needs attention".
 *
 * Terminal deals are excluded: a won or lost deal is not being worked, so a
 * clock that exists to say "nobody has touched this lately" has nothing to
 * say about it.
 *
 * WHICH ROWS EITHER BRANCH MAY TOUCH is `CLOCK_ELIGIBLE_SQL` above — the
 * same predicate for both, which it very deliberately was not before.
 */
async function advanceContactClock(input: LogActivityInput, query: TxQuery): Promise<void> {
  const set = `next_action_at = ${nextActionAssignment(input.kind)},
              last_contacted_at = now(),
              updated_at = now()`;

  if (input.opportunityId) {
    await query(
      `UPDATE crm_opportunities
          SET ${set}
        WHERE id = $1
          AND ${CLOCK_ELIGIBLE_SQL}`,
      [input.opportunityId],
    );
    return;
  }

  await query(
    `UPDATE crm_opportunities
        SET ${set}
      WHERE organisation_id = $1
        AND ${CLOCK_ELIGIBLE_SQL}`,
    [input.organisationId],
  );
}
