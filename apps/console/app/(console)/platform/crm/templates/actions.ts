"use server";

import { revalidatePath } from "next/cache";
import { UnknownMergeFieldError } from "@/lib/crm-merge-fields";
import { withCrmWrite, type CrmActionResult } from "@/lib/crm-write";
import {
  archiveTemplate,
  createTemplate,
  type TemplateChannel,
} from "@/lib/db/crm-templates";

/**
 * The lead-templates surface's two writes, both through `withCrmWrite`
 * (Ruling 17): session check, capability gate, `auditedOperation` and error
 * mapping all live there, shared with `suppressions/actions.ts` and
 * `[organisation]/actions.ts`. This file adds only what is genuinely local —
 * the emptiness rules, and the one exception it allowlists.
 *
 * ══ WHY EMPTINESS IS CHECKED HERE AND NOT IN THE REPOSITORY ══
 *
 * `createTemplate` deliberately does not check it (see its header): trimming
 * and emptiness are presentation-boundary concerns with an operator-facing
 * sentence attached, and `lib/db/crm-templates.ts` stays plain data access —
 * the same layering `removeSuppression` follows.
 *
 * The consequence worth stating: this check runs BEFORE the session is
 * fetched and before `withCrmWrite` is entered, so an empty submission never
 * reaches the database, never opens a transaction and never writes an audit
 * row. That is not an optimisation. `crm_templates` has no NOT-EMPTY
 * constraint — `name` and `body` are `NOT NULL`, and `''` satisfies `NOT NULL`
 * — so a nameless template WOULD be accepted by Postgres and would then sit in
 * every composer's picker as a blank line an operator cannot identify or
 * distinguish from the next blank line. This function is the only thing
 * standing between that and the picker.
 */

/**
 * `UnknownMergeFieldError` is the ONE exception this surface allowlists past
 * `withCrmWrite`'s generic "not saved".
 *
 * It is safe to show verbatim because it is authored for an operator and
 * carries no database detail: it names the bad tokens and lists the six that
 * exist. It is NECESSARY to show because "that change was not saved" gives the
 * author of a typo'd `{{contact.followers}}` nothing to act on — and they are
 * the only person who can fix it, holding the text, right now. Discovering it
 * later means discovering it mid-send on someone else's screen.
 *
 * `cause.message` rather than a sentence composed here, for the reason
 * `previewTemplate` records at its own call site: the authoring form and the
 * preview must name a bad token identically, or an operator who meets both
 * learns they are two different problems.
 *
 * Everything else — pg errors, the `crm_template_subject_is_email_only` CHECK,
 * audit failures — falls through to the wrapper's generic message. This is an
 * allowlist of one, not a "show any Error".
 */
function mapUnknownMergeField(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof UnknownMergeFieldError) {
    return { ok: false, message: cause.message };
  }
  return undefined;
}

export interface CreateTemplateActionInput {
  name: string;
  channel: TemplateChannel;
  product?: string | null;
  subject?: string | null;
  body: string;
}

export async function createTemplateAction(
  input: CreateTemplateActionInput,
): Promise<CrmActionResult> {
  // Trimmed here, not only in the client form: a server action is a
  // network-reachable endpoint in its own right, and the form's `.trim()` is
  // not the boundary that matters. Same rule as `addSuppressionAction`.
  const name = input.name.trim();
  const body = input.body.trim();
  const product = input.product?.trim() || null;
  // NOT nulled when the channel is `dm`. A subject submitted against a DM
  // template is passed through and rejected by
  // `crm_template_subject_is_email_only` — quietly dropping the operator's
  // words here is exactly the silent loss 0043's CHECK exists to prevent, and
  // `createTemplate`'s header records the same decision one layer down.
  const subject = input.subject?.trim() || null;

  if (!name) {
    return { ok: false, message: "Give the template a name." };
  }
  if (!body) {
    return { ok: false, message: "Write the message body." };
  }

  const result = await withCrmWrite(
    // Ruling 20: the readable fact. `console_audit_log.target` is what an
    // auditor reads first, and the row's uuid does not exist yet at this
    // point anyway — the name is both the honest identifier and the same one
    // the archive path below reports.
    name,
    { capability: "crm" },
    // `actor.email` for `crm_templates.created_by`, which the list renders
    // beside each template — the same column/identity pairing `addSuppression`
    // uses. The AUDIT actor is `actor.sub`; `withCrmWrite` supplies that
    // itself, and the two must not be swapped (Critical 2).
    (actor) =>
      createTemplate({ name, channel: input.channel, product, subject, body, actor: actor.email }),
    () => ({ action: "crm.template.create", summary: { created: 1 } }),
    mapUnknownMergeField,
  );
  if (!result.ok) return result;
  revalidatePath("/platform/crm/templates");
  return { ok: true };
}

export async function archiveTemplateAction(id: string): Promise<CrmActionResult> {
  const result = await withCrmWrite(
    // Fallback only: `describe` below supplies the template's name once the
    // row is in hand. Used verbatim only when nothing matched.
    id,
    { capability: "crm" },
    () => archiveTemplate(id),
    (rows) => ({
      action: "crm.template.archive",
      // The real outcome, not an assumption. `archiveTemplate`'s
      // `WHERE id = $1 AND NOT is_archived` matches nothing on a second
      // archive or an unknown id, so that case audits honestly as
      // `{ archived: 0 }` rather than recording a retirement that did not
      // happen — the same rule `removeSuppressionAction` follows.
      summary: { archived: rows.length },
      // Ruling 20 again: the name, not the uuid it was looked up by. Archiving
      // is the one irreversible-feeling thing on this surface, and "which
      // template did we retire?" is unanswerable from a uuid the moment the
      // row stops appearing in the list.
      target: rows[0]?.name ?? id,
    }),
  );
  if (!result.ok) return result;
  revalidatePath("/platform/crm/templates");
  return { ok: true };
}
