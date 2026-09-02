import { tesserixTx } from "./tesserix";
import { advanceStageOnQuery, assertNoSuppressedContact, CLOCK_ELIGIBLE_SQL } from "./crm-repo";
// `NEXT_ACTION_DAYS` was declared here. It moved to `lib/crm.ts` when #502
// gave the plain activity log the same default: two modules scheduling "the
// follow-up" a different number of days out is a disagreement no reader could
// resolve, and the composer needs the same number again to prefill with.
import { NEXT_ACTION_DAYS, type CrmStage } from "../crm";

/**
 * The single transaction behind "copy this DM and log that it was sent"
 * (#LDQ).
 *
 * ══ CONSTRAINT 2: `crm_activities.body` NEVER RECEIVES THE RENDERED MESSAGE ══
 *
 * The render embeds `crm_contacts.biography` — scrape-derived personal data
 * about someone who never filled in a form, which is 0019's own description of
 * what this table holds. `eraseContact` (`crm-erasure.ts`) nulls a contact's
 * identifying columns and empties its metadata bag, and it does NOT touch
 * `crm_activities`: activities are destroyed only by the organisation delete
 * cascade, which answers an entirely different request ("this business should
 * not be here" rather than "forget me"). So a rendered body written here would
 * outlive the erasure request that was supposed to destroy the data it was
 * derived from, sitting in a table the erasure path cannot reach. Migration
 * 0027's DPDP paragraph names that exact situation "a compliance defect, not a
 * feature".
 *
 * What is persisted instead is `template_id` and `rendered_at` — enough to
 * reconstruct WHAT WAS SENT from the template plus the contact row, and by
 * construction that reconstruction stops working the moment the contact is
 * erased. That is the correct behaviour rather than a limitation: after an
 * erasure, nobody should be able to recover the text.
 *
 * The proof is `crm-outreach.integration.test.ts` — a separate file on purpose,
 * so the guarantee reads as one diff rather than being buried in the feature
 * that needs it.
 *
 * ══ THE EDITED-TEXT EXCEPTION, AND HOW THE TWO ARE TOLD APART ══
 *
 * An operator may rewrite the message before sending it. That text is theirs,
 * it is the record of what they actually said, and it goes in `body`.
 *
 * The distinction is drawn SERVER-SIDE, by `copyAndLogDm` re-rendering the
 * template from `templateId` plus the live contact row and comparing that
 * string to what the client submitted. Identical → the operator sent our
 * render → `bodyIfEdited` is null → `body` is NULL. Different → the operator
 * wrote it → the text is stored.
 *
 * IT IS NOT A CLIENT FLAG, and that is the whole design. A caller that could
 * claim `edited: true` while submitting the verbatim render would smuggle the
 * biography into `body` through the one door in this feature that accepts free
 * text — and it is the only door, so a flag here would defeat every other
 * control at once. `metadata.edited` IS recorded, but it is DERIVED from the
 * comparison and passed down as `bodyIfEdited !== null`; it is never read from
 * a request.
 *
 * ══ THE RESIDUAL, STATED RATHER THAN HIDDEN ══
 *
 * An operator who edits one character keeps the rest of the render, biography
 * included, and that text is then genuinely theirs and is stored. This is
 * accepted: a human deciding what to send is the thing this feature exists to
 * preserve, and a rule that refused to store what a human actually wrote would
 * make the outreach log a work of fiction. It is precisely WHY
 * `metadata.edited` is recorded — an erasure request can then find the small
 * set of rows a human authored (`metadata->>'edited' = 'true'`) instead of
 * having to read every activity in the table.
 *
 * ══ WHY THIS IS ONE TRANSACTION ══
 *
 * The activity, the next-action clock, the drift clock and the `new` →
 * `contacted` move are one event. Half of them landing is worse than none: a
 * `dm_sent` row with the lead still at `new` puts it back in the operator's
 * queue to be DMed a second time, and a stage move with no activity is the
 * corruption `advanceStage`'s one-transaction guarantee exists to prevent.
 * `tesserixTx` does not nest, which is why `advanceStageOnQuery` and
 * `assertNoSuppressedContact` are handed out by `crm-repo.ts` rather than
 * reimplemented here.
 */

/**
 * Thrown when the template a caller named cannot be used for this write.
 *
 * Separate from "the render refused": this is about the TEMPLATE ROW, checked
 * inside the transaction. Two cases reach it — the template was archived or
 * deleted between the preview and the click, and the template is an `email`
 * one. The second matters because this function writes `kind = 'dm_sent'`
 * unconditionally: logging an email template as a DM would put a claim in the
 * outreach log that the operator never made, and `crm_activities` is the record
 * that later says how a lead was worked.
 */
export class TemplateUnavailableError extends Error {
  constructor(readonly templateId: string, message: string) {
    super(message);
    this.name = "TemplateUnavailableError";
  }
}

/**
 * Thrown when the contact is not (any longer) a contact of this organisation.
 *
 * Covers both halves of one check, deliberately sharing a message: a
 * `contactId` from a DIFFERENT organisation (T-LDQ-03 — every read and write
 * here is scoped by `organisationId`, so a hand-crafted request cannot reach
 * across), and a contact ERASED between the preview and the click. Telling the
 * two apart would answer exactly the question the scoping exists to refuse.
 *
 * The erasure half is the same both-ends rule the suppression check follows:
 * `templateContext` already excludes `erased_at IS NOT NULL`, but a preview is
 * a promise about a state that may already be old, and `eraseContact` writes
 * the literal `'[erased]'` into `name` — so an erased contact survives every
 * null check in this feature and only an explicit filter catches it.
 */
export class ContactUnavailableError extends Error {
  constructor(readonly contactId: string) {
    super("That contact is no longer available. It may have been erased.");
    this.name = "ContactUnavailableError";
  }
}

/**
 * Thrown by `copyAndLogDm` when the SERVER-SIDE re-render refuses.
 *
 * It lives in this module, not beside the action, for a mechanical reason: a
 * `"use server"` file may only export async functions, so an error class the
 * action needs to throw and allowlist has to be declared somewhere else. This
 * is the module the action already imports for the write, so putting it here
 * keeps the write path's vocabulary in one file rather than inventing a
 * third one.
 *
 * The message is the preview's own operator-facing wording (it names the
 * missing field), carried through `mapError` unchanged so the refusal an
 * operator meets at the click is worded identically to the one they would have
 * met at the preview.
 */
export class TemplateRenderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateRenderRefusedError";
  }
}

export interface RecordTemplatedDmInput {
  organisationId: string;
  contactId: string;
  templateId: string;
  /**
   * The operator's OWN text, or `null` when they sent our render verbatim.
   *
   * Named `bodyIfEdited` rather than `body` so that the only way to reach
   * `crm_activities.body` is to have already decided, elsewhere and for a
   * reason, that this text is not ours. `copyAndLogDm` is the only caller that
   * makes that decision, and it makes it by re-rendering server-side — see
   * this module's header.
   */
  bodyIfEdited: string | null;
  actor: string;
}

export interface RecordTemplatedDmResult {
  activityId: string;
  /** Derived, never supplied: `bodyIfEdited !== null`. */
  edited: boolean;
  /** What the audit row names, so the caller never has to reach for the
   *  message text to identify who was contacted. Null when the contact has
   *  neither a handle nor an email on file. */
  contactLabel: string | null;
  /** Open deals whose clocks moved, and how many of those were also advanced
   *  out of `new`. Counted from what the statements actually reported rather
   *  than assumed, so the audit row cannot overstate the write. */
  opportunitiesTouched: number;
  stagesAdvanced: number;
}

interface TemplateRow {
  name: string;
  channel: "dm" | "email";
  is_archived: boolean;
}

/**
 * Log a templated DM as sent, and move everything that sending one implies.
 *
 * The order below is load-bearing and each step says why.
 */
export async function recordTemplatedDm(
  input: RecordTemplatedDmInput,
): Promise<RecordTemplatedDmResult> {
  const { organisationId, contactId, templateId, bodyIfEdited, actor } = input;
  const edited = bodyIfEdited !== null;

  return tesserixTx(async (query) => {
    // ── 1. THE SUPPRESSION RE-CHECK ────────────────────────────────────────
    //
    // First, before anything is read or written. The preview already refused a
    // suppressed organisation (`previewTemplate`), but a preview is a promise
    // about a state that may already be old — the CSV import holds the same
    // rule at both ends for the same reason. Run on the TRANSACTION's client so
    // the check and the insert cannot straddle a suppression being added
    // concurrently: an operator who has the text on their clipboard is exactly
    // the case where a stale "no" is expensive.
    //
    // `assertNoSuppressedContact` — organisation-scoped, the same function the
    // preview calls — rather than a per-contact `isSuppressed`. A narrower
    // check here than at preview would let a lead pass the preview and throw
    // here, AFTER the clipboard write, which is the one moment the two ends
    // disagreeing costs the most.
    await assertNoSuppressedContact(organisationId, query);

    // ── 2. THE TEMPLATE AND THE CONTACT, BOTH SCOPED ───────────────────────
    //
    // Read inside the transaction, not taken from the caller's word for it.
    // `metadata.template_id` is the only thing that can later say what was
    // sent (see the header), so recording an id that resolves to nothing would
    // quietly hollow out the single fact this row is keeping.
    const templateRows = await query<TemplateRow>(
      `SELECT name, channel, is_archived FROM crm_templates WHERE id = $1`,
      [templateId],
    );
    const template = templateRows[0];
    if (!template || template.is_archived) {
      throw new TemplateUnavailableError(
        templateId,
        "That template is no longer available.",
      );
    }
    if (template.channel !== "dm") {
      throw new TemplateUnavailableError(
        templateId,
        "That template is an email template and cannot be logged as a DM.",
      );
    }

    const contactRows = await query<{ email: string | null; instagram_handle: string | null }>(
      `SELECT email, instagram_handle
         FROM crm_contacts
        WHERE id = $1
          AND organisation_id = $2
          AND erased_at IS NULL`,
      [contactId, organisationId],
    );
    const contact = contactRows[0];
    if (!contact) throw new ContactUnavailableError(contactId);

    // ── 3. THE ACTIVITY ────────────────────────────────────────────────────
    //
    // `body` is `bodyIfEdited ?? NULL` and nothing else. Read the header before
    // changing this line; the whole of `crm-outreach.integration.test.ts`
    // exists to make changing it fail.
    //
    // `opportunity_id` is NULL: a DM goes to the BUSINESS, and asking an
    // operator which deal a cold intro belongs to is a question they usually
    // cannot answer — the same organisation-level choice `ActivityComposer`
    // already makes, with the same consequence in step 4 (every open deal's
    // clock moves, not one).
    const activityRows = await query<{ id: string }>(
      `INSERT INTO crm_activities (organisation_id, contact_id, kind, actor, body, metadata)
       VALUES ($1, $2, 'dm_sent', $3, $4, $5::jsonb)
       RETURNING id`,
      [
        organisationId,
        contactId,
        actor,
        bodyIfEdited,
        JSON.stringify({
          template_id: templateId,
          rendered_at: new Date().toISOString(),
          edited,
        }),
      ],
    );

    // ── 4. THE CLOCKS ──────────────────────────────────────────────────────
    //
    // Every OPEN deal, for the reason `advanceContactClock` records at length
    // (#245): an activity naming no deal touched all of the ones still in play,
    // not none of them, and "none" is how every imported organisation ended up
    // permanently Drifting.
    //
    // GRANDFATHERED AND TERMINAL ROWS ARE EXCLUDED by `CLOCK_ELIGIBLE_SQL`,
    // which is imported rather than spelled out here — the predicate used to
    // be written out in this statement and again, twice and inconsistently, in
    // `advanceContactClock`. It is one constant now for the reason its own
    // comment gives: the copy that lacked the 0021 guard aborted the whole
    // transaction and took the activity row with it.
    const touched = await query<{ id: string; stage: CrmStage }>(
      `UPDATE crm_opportunities
          SET next_action_at = now() + ($2 || ' days')::interval,
              next_action_note = $3,
              last_contacted_at = now(),
              updated_at = now()
        WHERE organisation_id = $1
          AND ${CLOCK_ELIGIBLE_SQL}
        RETURNING id, stage`,
      [organisationId, String(NEXT_ACTION_DAYS), `Follow up on "${template.name}"`],
    );

    // ── 5. THE STAGE MOVE ──────────────────────────────────────────────────
    //
    // `advanceStageOnQuery`, NOT a hand-written UPDATE. The rule that every
    // stage transition writes a `stage_change` activity in the same
    // transaction belongs to `crm-repo.ts`, and Task 5 exported this function
    // precisely so a second caller could honour it rather than copy it — a
    // second copy is one that can stop agreeing in a single commit.
    //
    // `RETURNING stage` above reports the stage as it stood before this move
    // (step 4 does not touch `stage`), so this filters on the pre-move value.
    // Deals already past `new` are left alone: a DM to a qualified lead is
    // contact, not a transition, and a same-stage call would be a no-op anyway.
    const advancing = touched.filter((row) => row.stage === "new");
    for (const row of advancing) {
      await advanceStageOnQuery(query, {
        opportunityId: row.id,
        to: "contacted",
        actor,
      });
    }

    return {
      activityId: activityRows[0].id,
      edited,
      contactLabel: contact.instagram_handle ?? contact.email,
      opportunitiesTouched: touched.length,
      stagesAdvanced: advancing.length,
    };
  });
}
