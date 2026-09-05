import { requiresProduct } from "../crm";
import type { CrmStage } from "../crm";
import { MissingProductError } from "./crm-repo";
import { tesserixTx } from "./tesserix";
import type { TxQuery } from "./tesserix";

/**
 * Taking a deal OUT of the funnel without destroying it (#251).
 *
 * Kept out of `crm-erasure.ts` deliberately. That file holds the two
 * DESTRUCTIVE operations behind a DPDP request, and its header says so; a
 * void is neither destructive nor a DPDP answer. It is the third intent —
 * "this deal was a mistake" — and the erasure design depends on that
 * distinction staying legible, so the two live in separate files.
 *
 * A void keeps the row, its foreign key and its parent organisation. The
 * stage the deal reached stays true and stays readable: `voided_at` is a
 * second fact about the row, not a sixth value of `stage`.
 *
 * ══ THE 0021 CHECK, WHICH IS WHY THIS IS NOT A ONE-LINE UPDATE ══
 *
 * `crm_opp_product_required_when_qualified` (`stage IN ('new','contacted')
 * OR product IS NOT NULL`) was re-added `NOT VALID` in migration 0021.
 * `NOT VALID` skips only the initial validation scan — Postgres still
 * evaluates the CHECK against the new row of every UPDATE, whatever columns
 * that UPDATE touched. A DELETE evaluates no CHECK at all, which is why the
 * hard delete this replaces never met the constraint and why a void does.
 *
 * So a bare `SET voided_at = now()` raises a raw 23514 on any of the ~155
 * rows the lead backfill grandfathered in at `qualified`/`won`/`lost` with
 * a null product — precisely the rows an operator most wants to void. Both
 * functions below therefore read the row `FOR UPDATE` first and refuse with
 * `MissingProductError` before the UPDATE runs, the same guard and the same
 * reason as `setNextAction` in `crm-repo.ts`. The console already renders
 * that error through `mapMissingProduct`, so a grandfathered row is a
 * visible, typed refusal rather than a database error surfacing raw.
 *
 * Backfilling `product` across those rows to validate the constraint is a
 * real data migration, and inventing a product for a historical deal
 * fabricates attribution the funnel would then report as fact — the reason
 * 0019 left `product` nullable in the first place.
 *
 * ══ WHY THE ACTIVITY IS A `note` ══
 *
 * Both operations write a `crm_activities` row inside their own
 * transaction, `kind: 'note'` with structured `metadata`. The precedent is
 * `advanceStageOnQuery`'s product-change note. Never `stage_change`: that
 * kind carries `{from, to}` and is the funnel's source of truth for stage
 * timing, so a void written as one would inject a transition that never
 * happened into the exact aggregate this whole design exists to protect.
 * `crm_activity_kind` is a closed enum and no migration has ever added a
 * value to it; a dedicated `void` kind would be an `ALTER TYPE` every
 * reader, label map and Go-side parser then has to learn, which is not
 * worth it for a note that already reads correctly.
 */

interface OpportunityVoidState {
  organisation_id: string;
  organisation_name: string;
  stage: CrmStage;
  product: string | null;
  voided_at: string | null;
}

/**
 * Which deal this was, in the words an audit reader can use without joining
 * anything. An opportunity has no name of its own — it is identified by
 * whose business it belongs to and what it was for — so the caller's audit
 * `target` needs the organisation's name and the product beside the id. Read
 * here, under the same lock as the write, rather than by the action layer in
 * a second query: a name fetched separately is a name that could have moved
 * between the two reads, and the audit row would then describe a state that
 * never existed. Returned on the no-op outcomes too, because a refusal row
 * naming the deal is worth exactly as much as a success one.
 */
export interface VoidedOpportunityIdentity {
  opportunityId: string;
  organisationId: string;
  organisationName: string;
  product: string | null;
}

/**
 * Read the row this write is about to touch, holding it for the duration of
 * the transaction, and refuse the grandfathered case.
 *
 * The lock matters because both callers decide whether to write at all from
 * what they read here — without `FOR UPDATE`, two concurrent voids could
 * both read "live" and both write, producing two notes for one void.
 */
async function lockForVoidWrite(
  query: TxQuery,
  opportunityId: string,
  operation: string,
): Promise<OpportunityVoidState> {
  const rows = await query<OpportunityVoidState>(
    // `FOR UPDATE OF o` — the lock this needs is on the deal. Without the
    // `OF`, the join would lock the organisation row as well, and every
    // concurrent write to any of that organisation's other deals would then
    // queue behind this one.
    `SELECT o.organisation_id, o.stage, o.product, o.voided_at,
            org.name AS organisation_name
       FROM crm_opportunities o
       JOIN crm_organisations org ON org.id = o.organisation_id
      WHERE o.id = $1
        FOR UPDATE OF o`,
    [opportunityId],
  );
  const current = rows[0];
  if (!current) {
    throw new Error(`${operation}: opportunity ${opportunityId} not found`);
  }
  return current;
}

/** A blank reason is not a reason. `voided_reason` is optional on a void, so
 *  whitespace collapses to NULL rather than being stored as text that reads
 *  as an explanation on the card and says nothing. */
function normaliseReason(reason: string | null): string | null {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : null;
}

/** The locked read, in the shape the caller's audit row names the deal by. */
function identify(
  opportunityId: string,
  current: OpportunityVoidState,
): VoidedOpportunityIdentity {
  return {
    opportunityId,
    organisationId: current.organisation_id,
    organisationName: current.organisation_name,
    product: current.product,
  };
}

export interface VoidOpportunityInput {
  opportunityId: string;
  /** Free text, optional — `crm_opp_void_reason_requires_void` is an
   *  implication, not a biconditional, so a void with no reason is a legal
   *  state. */
  reason: string | null;
  actor: string;
}

/** What actually happened, so the action/audit layer can name the write
 *  honestly instead of assuming one occurred. `{ voided: false }` is the
 *  already-voided case: a valid, zero-effect outcome, not an error. Same
 *  shape and same reasoning as `AdvanceStageResult` in `crm-repo.ts`. */
export interface VoidOpportunityResult extends VoidedOpportunityIdentity {
  voided: boolean;
}

/**
 * Take a deal out of the funnel, reversibly.
 *
 * `updated_at` is set by hand: `crm_opportunities` carries no `updated_at`
 * trigger (0019 defines the table with a plain `DEFAULT now()` and no
 * trigger exists on it in any migration), so a write that does not name the
 * column leaves it reading as the time of the last write that did.
 */
export async function voidOpportunity(
  input: VoidOpportunityInput,
): Promise<VoidOpportunityResult> {
  const { opportunityId, actor } = input;
  const reason = normaliseReason(input.reason);

  return tesserixTx(async (query) => {
    const current = await lockForVoidWrite(query, opportunityId, "voidOpportunity");
    const identity = identify(opportunityId, current);

    // Checked before the product guard on purpose: an already-voided deal
    // needs no UPDATE, so it evaluates no CHECK, so a grandfathered row
    // that somehow reached the voided set stays idempotently voidable
    // rather than erroring on a call that would have changed nothing.
    if (current.voided_at !== null) {
      return { ...identity, voided: false };
    }
    if (requiresProduct(current.stage) && !current.product) {
      throw new MissingProductError(opportunityId);
    }

    await query(
      `UPDATE crm_opportunities
          SET voided_at = now(), voided_reason = $2, updated_at = now()
        WHERE id = $1`,
      [opportunityId, reason],
    );

    await query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata)
       VALUES ($1, $2, 'note', $3, $4, $5::jsonb)`,
      [
        current.organisation_id,
        opportunityId,
        actor,
        reason ? `Deal voided: ${reason}` : "Deal voided",
        JSON.stringify({ voidAction: "voided", reason }),
      ],
    );

    return { ...identity, voided: true };
  });
}

export interface RestoreOpportunityInput {
  opportunityId: string;
  actor: string;
}

/** `{ restored: false }` is the already-live case — a no-op, not an error. */
export interface RestoreOpportunityResult extends VoidedOpportunityIdentity {
  restored: boolean;
}

/**
 * Put a voided deal back in the funnel.
 *
 * The same UPDATE, so the same 0021 CHECK and the same guard. In practice
 * that guard is unreachable through this module — a row that could not be
 * voided cannot be in the voided set, so a voided row has already proven it
 * satisfies the CHECK. It is kept anyway because that argument holds only
 * for rows this module voided: a `voided_at` set by hand in psql, or by any
 * future path, would otherwise hit the constraint raw. Stating it here so
 * the next reader does not delete the guard as dead code.
 *
 * `voided_reason` is cleared alongside `voided_at`, not left behind:
 * `crm_opp_void_reason_requires_void` would reject the row, and a live deal
 * carrying an explanation for a void no longer in force is readable on the
 * card and wrong.
 */
export async function restoreOpportunity(
  input: RestoreOpportunityInput,
): Promise<RestoreOpportunityResult> {
  const { opportunityId, actor } = input;

  return tesserixTx(async (query) => {
    const current = await lockForVoidWrite(query, opportunityId, "restoreOpportunity");
    const identity = identify(opportunityId, current);

    if (current.voided_at === null) {
      return { ...identity, restored: false };
    }
    if (requiresProduct(current.stage) && !current.product) {
      throw new MissingProductError(opportunityId);
    }

    await query(
      `UPDATE crm_opportunities
          SET voided_at = NULL, voided_reason = NULL, updated_at = now()
        WHERE id = $1`,
      [opportunityId],
    );

    await query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata)
       VALUES ($1, $2, 'note', $3, $4, $5::jsonb)`,
      [
        current.organisation_id,
        opportunityId,
        actor,
        "Deal restored",
        JSON.stringify({ voidAction: "restored" }),
      ],
    );

    return { ...identity, restored: true };
  });
}
