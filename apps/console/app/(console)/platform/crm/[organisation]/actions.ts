"use server";

import { revalidatePath } from "next/cache";
import { ESTATE } from "@tesserix/console-core";
import {
  advanceStage,
  logActivity,
  linkConversion as linkConversionRow,
  MissingProductError,
  AlreadyLinkedError,
  SuppressedContactError,
  type AdvanceStageResult,
} from "@/lib/db/crm-repo";
import { saveNextAction } from "@/lib/crm-queues";
import {
  createContact,
  createOpportunity as createOpportunityRow,
  updateOrganisation,
  DuplicateContactError,
  type ChangedField,
  type OrganisationField,
} from "@/lib/db/crm-writes";
import { isSafeWebsiteUrl, UNSAFE_WEBSITE_URL_MESSAGE } from "@/lib/db/crm-url";
import {
  eraseContact as eraseContactRow,
  deleteOrganisation as deleteOrganisationRow,
} from "@/lib/db/crm-erasure";
import { ErasureHashKeyMissingError } from "@/lib/db/crm-erasure-hash";
import { AuditWriteError } from "@/lib/db/audit-repo";
import { withCrmWrite, type CrmActionResult } from "@/lib/crm-write";
import { isCrmStage, isHumanActivityKind, requiresProduct } from "@/lib/crm";


/**
 * `crm_opportunities.product` and `crm_organisations.converted_product` are
 * plain `text` columns with no CHECK and no foreign key — the estate is a
 * TypeScript constant, not a table, so the database cannot police them.
 * Every product value that reaches either column is what the funnel later
 * reports attribution by, and a typo ("mark8ley") or a hand-crafted request
 * body writes a product that does not exist, silently, forever. Validated at
 * this boundary because there is nowhere below it that can be.
 */
const ESTATE_CONTEXTS: ReadonlySet<string> = new Set(ESTATE.map((p) => p.context));

function isEstateProduct(value: string): boolean {
  return ESTATE_CONTEXTS.has(value);
}

function unknownProductMessage(value: string): string {
  return `"${value}" is not a product in the estate.`;
}

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
  if (input.product && !isEstateProduct(input.product)) {
    return { ok: false, message: unknownProductMessage(input.product) };
  }
  if (input.to === "lost" && !input.lostReason) {
    return { ok: false, message: `Marking an opportunity "lost" requires a reason.` };
  }

  const to = input.to;
  const result = await withCrmWrite(
    input.opportunityId,
    { capability: "crm" },
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
    mapMissingProduct);
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
    { capability: "crm" },
    (actor) =>
      saveNextAction({
        opportunityId: input.opportunityId,
        at: input.at,
        note: input.note,
        actor: actor.email,
      }),
    () => ({ action: "crm.next_action.set", summary: { scheduled: 1 } }),
    mapMissingProduct);
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
/**
 * The second allowlisted exception on this surface: `SuppressedContactError`
 * is the do-not-contact list refusing outreach (design.md:224), which is an
 * operator-facing fact with a clear next step, not a caught database error.
 */
function mapSuppressedContact(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof SuppressedContactError) {
    return { ok: false, message: cause.message };
  }
  return undefined;
}

/**
 * The second allowlisted exception on the manual-create path.
 *
 * A `23505` on `crm_contacts_email_lower_uq` or
 * `crm_contacts_instagram_lower_uq` is an operator-facing fact with a clear
 * next step — that contact is already in the CRM — not a caught database
 * error. `createContact`/`createOrganisation` raise it typed
 * (`DuplicateContactError`, crm-writes.ts) precisely so this mapper can pass
 * the message through without inspecting a database error string here. The
 * import path resolves the same condition informatively as `matchedExisting`
 * (crm-repo.ts); the manual door was where it degraded to the generic
 * "That change was not saved."
 */
function mapDuplicateContact(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof DuplicateContactError) {
    return { ok: false, message: cause.message };
  }
  return undefined;
}

/** Both refusals a hand-typed contact can produce, in one allowlist. */
function mapContactRefusal(cause: unknown): { ok: false; message: string } | undefined {
  return mapSuppressedContact(cause) ?? mapDuplicateContact(cause);
}

export async function addActivity(input: AddActivityInput): Promise<CrmActionResult> {
  if (!isHumanActivityKind(input.kind)) {
    return { ok: false, message: `"${input.kind}" is not an activity kind an operator can log directly.` };
  }

  const kind = input.kind;
  const result = await withCrmWrite(
    input.opportunityId ?? input.organisationId,
    { capability: "crm" },
    (actor) =>
      logActivity({
        organisationId: input.organisationId,
        opportunityId: input.opportunityId,
        kind,
        actor: actor.email,
        body: input.body,
      }),
    () => ({ action: "crm.activity.log", summary: { logged: 1 } }),
    mapSuppressedContact);
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
 * Ruling 30's one allowlisted exception: `AlreadyLinkedError` is a clear,
 * operator-facing fact (a second confirmation lost a race against the
 * first), not a caught database error — same treatment `mapMissingProduct`
 * gives its own well-known exception above.
 */
function mapAlreadyLinked(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof AlreadyLinkedError) {
    return { ok: false, message: "This organisation already has a conversion recorded." };
  }
  return undefined;
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
  if (!isEstateProduct(product)) {
    return { ok: false, message: unknownProductMessage(product) };
  }
  if (!isLinkMethod(input.method)) {
    return { ok: false, message: `"${input.method}" is not a valid link method.` };
  }

  const method = input.method;
  const result = await withCrmWrite(
    input.organisationId,
    { capability: "crm" },
    (actor) =>
      linkConversionRow({
        organisationId: input.organisationId,
        product,
        ref,
        label,
        method,
        actor: actor.email,
      }),
    (outcome) => ({
      action: "crm.conversion.link",
      summary: { linked: 1 },
      // The id alongside the name (Ruling 20-style): a display name alone
      // is neither unique nor stable, which would make this the one CRM
      // audit row an operator can't join back to a real record.
      target: `${outcome.organisationName} (${outcome.organisationId})`,
    }),
    mapAlreadyLinked);
  if (!result.ok) return result;
  revalidatePath("/platform/crm");
  revalidatePath(`/platform/crm/${input.organisationId}`);
  return { ok: true };
}

export interface AddContactInput {
  organisationId: string;
  name?: string;
  email?: string;
  phone?: string;
  instagramHandle?: string;
}

/**
 * Add a contact to an existing organisation. The other half of the
 * manual-create door (#213): `organisations/new` covers the first contact
 * on a brand-new organisation, this covers every one after — a second phone
 * number for an organisation that's already in the CRM.
 *
 * At least one identifying field is required, checked before any session or
 * database work: a contact row with nothing in it is unfindable and
 * unreachable, the same reasoning `createOrganisation` applies to a blank
 * organisation name.
 */
export async function addContactAction(input: AddContactInput): Promise<CrmActionResult> {
  const name = input.name?.trim() || undefined;
  const email = input.email?.trim() || undefined;
  const phone = input.phone?.trim() || undefined;
  const instagramHandle = input.instagramHandle?.trim() || undefined;

  if (!name && !email && !phone && !instagramHandle) {
    return { ok: false, message: "Enter at least a name, email, phone, or Instagram handle." };
  }

  const result = await withCrmWrite(
    input.organisationId,
    { capability: "crm" },
    () =>
      createContact({
        organisationId: input.organisationId,
        name,
        email,
        phone,
        instagramHandle,
      }),
    () => ({ action: "crm.contact.create", summary: { contacts: 1 } }),
    // `createContact` refuses a suppressed contact, and one whose email or
    // handle is already taken, at the data layer (crm-writes.ts). Both
    // allowlisted here: without them either refusal would surface as the
    // generic "That change was not saved." and read as a bug.
    mapContactRefusal);
  if (!result.ok) return result;
  revalidatePath(`/platform/crm/${input.organisationId}`);
  return { ok: true };
}

export interface CreateOpportunityInput {
  organisationId: string;
  product?: string;
  owner?: string;
}

/**
 * Open a new opportunity against an existing organisation.
 *
 * The design's third motivating case (crm-writes.ts): a business lost in
 * March that returns in November is a NEW opportunity against the same
 * organisation, not a resurrection of the old row. `product` is optional and
 * passed through exactly as given — never invented when the caller omits
 * it, same as `changeStage` above — but is checked against the estate when
 * supplied, since it is the same untyped `text` column with no CHECK.
 */
export async function createOpportunityAction(
  input: CreateOpportunityInput,
): Promise<CrmActionResult> {
  const product = input.product?.trim() || undefined;
  const owner = input.owner?.trim() || undefined;

  if (product && !isEstateProduct(product)) {
    return { ok: false, message: unknownProductMessage(product) };
  }

  const result = await withCrmWrite(
    input.organisationId,
    { capability: "crm" },
    () =>
      createOpportunityRow({
        organisationId: input.organisationId,
        product,
        owner,
      }),
    () => ({ action: "crm.opportunity.create", summary: { opportunities: 1 } }));
  if (!result.ok) return result;
  revalidatePath(`/platform/crm/${input.organisationId}`);
  return { ok: true };
}

/**
 * `AuditWriteError` fires AFTER `eraseContact` has already run and
 * committed — same timing as `mapDeleteAuditFailure` below, and the same
 * reasoning applies with more force: this is the DPDP path, where the audit
 * row IS the evidence a request was honoured (#140 consumes it as such), not
 * just a record for support to read later. `withCrmWrite`'s default "That
 * change was not saved." would tell the operator an overwrite of someone's
 * personal data never happened when it did. Worded to hold whether this call
 * was the one that erased the contact or the contact was already erased (or
 * never existed) — in every case the contact's details are, right now, not
 * present. Allowlisted to this one exception type, not "any Error".
 */
function mapEraseAuditFailure(cause: unknown): { ok: false; message: string } | undefined {
  // #226's fail-closed: with `CRM_ERASURE_HASH_KEY` unset, `eraseContact`
  // refuses rather than performing an erasure it cannot make stick against
  // the next import. Nothing was written, so "that change was not saved" is
  // literally true — and useless, because it reads as a transient failure and
  // an operator will click again forever. The remedy is a deployment change
  // and the message has to say so. It names a variable and no person.
  if (cause instanceof ErasureHashKeyMissingError) {
    return {
      ok: false,
      message:
        "This contact was NOT erased. CRM_ERASURE_HASH_KEY is not configured, so the erasure " +
        "could not be recorded in a form that stops the next import re-creating them. " +
        "Report this before telling anyone the request was honoured.",
    };
  }
  if (cause instanceof AuditWriteError) {
    return {
      ok: false,
      message:
        "The contact's details are gone, but that erasure was not recorded in the audit log. Please report this.",
    };
  }
  return undefined;
}

/**
 * Erase a contact's identifying data (DPDP "forget me" — #213/#154). The
 * organisation, its opportunities and its activity log are untouched; see
 * `eraseContact` in crm-erasure.ts for why that split matters.
 *
 * Gated on `hard-delete`, not the `read` every other CRM write shares — this
 * is the one action `withCrmWrite`'s capability actually fits. A missing
 * contact (already erased, or never existed) resolves to `{ ok: true }`:
 * "already gone" is the outcome an operator honouring an erasure request
 * wanted, not a failure to report.
 *
 * `eraseContact` returns `previousName` so the audit row can say who was
 * erased. It is deliberately retained there — `console_audit_log.target` is
 * the DPDP evidence the request was honoured, and an evidence row that
 * cannot name whose data was erased is worth nothing — and it is deliberately
 * kept out of THIS action's return value, because echoing it back would put
 * the erased person's name on the exact screen this action was just used to
 * remove it from. Two separate decisions, not one.
 */
export async function eraseContactAction(contactId: string): Promise<CrmActionResult> {
  const result = await withCrmWrite(
    contactId,
    { capability: "hard-delete" },
    () => eraseContactRow(contactId),
    (outcome) => {
      // `outcome.erasedAt` is the PRE-image: non-null means the contact was
      // ALREADY erased before this call. Reporting `erased: 1` here would
      // write a second, indistinguishable "this person was erased" row into
      // `console_audit_log` — the exact trail #140 consumes as evidence a
      // DPDP request was honoured — for a click that erased nothing new.
      const alreadyErased = outcome !== null && outcome.erasedAt !== null;
      return {
        action: "crm.contact.erase",
        summary: { erased: outcome && !alreadyErased ? 1 : 0 },
        // The name belongs here, in the free-string audit target, and only
        // here: never in `summary` (counts only) and never in the
        // CrmActionResult below. Keeping it in the audit row is what makes
        // that row evidence; keeping it out of the response is what stops it
        // being re-displayed.
        target: outcome
          ? `${outcome.previousName ?? "(no name on file)"} (${outcome.contactId})`
          : contactId,
      };
    },
    mapEraseAuditFailure);
  if (!result.ok) return result;
  if (result.value) {
    revalidatePath(`/platform/crm/${result.value.organisationId}`);
    // The browse list renders each organisation's primary contact name, so
    // without this the erased name stays on screen at
    // `/platform/crm/organisations` — the one surface that reaches a lead in
    // its first fourteen days, and the one `createOrganisationAction`
    // already revalidates. Inside the `result.value` guard, like the detail
    // path: a contact that was already gone changed nothing to revalidate.
    revalidatePath("/platform/crm/organisations");
  }
  return { ok: true };
}

/**
 * `AuditWriteError` is thrown by `auditedOperation` AFTER the operation has
 * already run and committed — see crm-write.ts:93-99. For most CRM writes
 * `withCrmWrite`'s conservative default ("That change was not saved.") is
 * still safe to tell an operator, because retrying one stage change is
 * harmless even if it did in fact save. It is not safe here: the operation
 * this wraps is a full cascade, already committed, and the default message
 * says the opposite of what happened. An operator told nothing was saved
 * will reasonably retry a delete that already ran — the organisation is
 * already gone, so a retry cannot make it "more" deleted, but the copy must
 * not send them looking for data that no longer exists. Allowlisted to this
 * one exception type, not "any Error", same discipline as `mapMissingProduct`
 * and `mapAlreadyLinked` above.
 *
 * Worded to hold in both cases `deleteOrganisationRow` can return: a real
 * cascade this call just performed, or `null` because the organisation was
 * already gone. "Was deleted" would be a lie in the second case — an
 * operator reading it would believe this call was the one that removed a
 * business that, in fact, this call found nothing to remove.
 */
function mapDeleteAuditFailure(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof AuditWriteError) {
    return {
      ok: false,
      message:
        "The organisation is gone, but that action was not recorded in the audit log. Please report this.",
    };
  }
  return undefined;
}

/**
 * Delete an organisation and everything under it (DPDP "this business
 * should not exist here" — #213/#154, distinct from erasure: see
 * `deleteOrganisation` in crm-erasure.ts for why the two must not collapse
 * into one action).
 *
 * Gated on `hard-delete`, same as `eraseContactAction`. A missing
 * organisation resolves to `{ ok: true }` — already gone is success, same
 * reasoning as above — and no audit row's counts are fabricated for it: the
 * `describe` callback reports zero of everything rather than guessing what
 * an already-absent organisation might have held.
 */
export async function deleteOrganisationAction(
  organisationId: string,
): Promise<CrmActionResult> {
  const result = await withCrmWrite(
    organisationId,
    { capability: "hard-delete" },
    () => deleteOrganisationRow(organisationId),
    (outcome) => ({
      action: "crm.organisation.delete",
      summary: outcome
        ? { contacts: outcome.contactsDeleted, opportunities: outcome.opportunitiesDeleted }
        : { contacts: 0, opportunities: 0 },
      // Ruling 20-style: the id alongside the name, so the one CRM audit row
      // for an org that no longer exists can still be joined back to it.
      target: outcome ? `${outcome.name} (${outcome.organisationId})` : organisationId,
    }),
    mapDeleteAuditFailure);
  if (!result.ok) return result;
  revalidatePath("/platform/crm");
  // Not just the queue: a deleted organisation that is still listed on the
  // browse surface links to a detail page that no longer exists.
  revalidatePath("/platform/crm/organisations");
  return { ok: true };
}

/**
 * Reads one scalar form field: trimmed, with empty-string collapsed to
 * `undefined`. A copy of `organisations/new/actions.ts`'s reader of the same
 * name rather than a shared import, because a `"use server"` module may only
 * export async functions.
 */
function optionalField(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Reads a field submitted zero or more times (`category`, `tags`) as a list,
 * applying the same trim-and-drop-empty rule `optionalField` applies to a
 * scalar — an untouched text input submits `""`, which is form noise rather
 * than a category. `updateOrganisation` normalises again, and additionally
 * de-duplicates; this is the form reader, not that contract.
 */
function listField(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .filter((raw): raw is string => typeof raw === "string")
    .map((raw) => raw.trim())
    .filter((raw) => raw !== "");
}

/**
 * `AuditSummary` is `Readonly<Record<string, number>>` — counts only — so
 * "which fields changed" is carried as one key per changed field rather than
 * as a list of names. The keys are the column names, since that is what an
 * auditor reading the row alongside the table will recognise.
 */
const SUMMARY_KEYS: Readonly<Record<OrganisationField, string>> = {
  name: "name",
  location: "location",
  websiteUrl: "website_url",
  category: "category",
  tags: "tags",
};

/**
 * A no-op save is reported as `{ fields: 0 }`, under the same
 * `crm.organisation.update` action as any other save — not a separate action
 * name, and not a suppressed audit row. An operator opening the form and
 * pressing save IS the event being accounted for; whether it happened to
 * change anything is the count's job to say, exactly as `changeStage` above
 * reports `{ transitions: 0 }`. The `fields` key is why the count is stated
 * rather than left implicit in an empty object: `{}` reads as a summariser
 * that failed to fill itself in, and cannot be told apart from one.
 *
 * (The data layer writes no UPDATE and no timeline row for a no-op — see
 * `updateOrganisation` in crm-writes.ts. This audit row is the console's own
 * record that an operator acted, which is a different question.)
 */
function summariseChanges(changed: readonly ChangedField[]): Record<string, number> {
  return changed.reduce<Record<string, number>>(
    (summary, { field }) => ({ ...summary, [SUMMARY_KEYS[field]]: 1 }),
    { fields: changed.length },
  );
}

/**
 * Correct an organisation's own fields — name, location, website, category,
 * tags — from the detail page (#227). Until this existed the only way to fix
 * a typo or an import-dropped URL was to delete the organisation, cascading
 * away its opportunities and its whole timeline.
 *
 * `updateOrganisation` is a FULL REPLACEMENT of those five fields, so the
 * form must submit every one of them on every save: a field this action does
 * not read is a field the writer clears.
 *
 * `name` and `websiteUrl` are validated here, before any session or database
 * work, so an invalid form never reaches `checkOperatorCapability` or the
 * audit trail — an invalid form is not an audited event. Both are checked
 * again in the data layer, which is where the guarantee lives; these two
 * exist to produce field-level messages on the form.
 *
 * No `capability` option: an edit sits with create at `withCrmWrite`'s
 * default gate, not on delete's `hard-delete`.
 */
export async function updateOrganisationAction(
  organisationId: string,
  formData: FormData,
): Promise<CrmActionResult> {
  const name = optionalField(formData, "name");
  if (!name) {
    return { ok: false, message: "Enter an organisation name." };
  }

  const websiteUrl = optionalField(formData, "websiteUrl");
  if (websiteUrl && !isSafeWebsiteUrl(websiteUrl)) {
    return { ok: false, message: UNSAFE_WEBSITE_URL_MESSAGE };
  }

  const result = await withCrmWrite(
    // Ruling 20-style: the id alongside the name. The name here is the one
    // being saved, so the audit row names the organisation as this edit left
    // it — the display name it had before is in the timeline diff, which is
    // the record that exists to answer "what was it called yesterday".
    `${name} (${organisationId})`,
    { capability: "crm" },
    (actor) =>
      updateOrganisation({
        organisationId,
        actor: actor.email,
        name,
        location: optionalField(formData, "location"),
        websiteUrl,
        category: listField(formData, "category"),
        tags: listField(formData, "tags"),
      }),
    (outcome) => ({
      action: "crm.organisation.update",
      summary: summariseChanges(outcome.changed),
    }));
  if (!result.ok) return result;
  revalidatePath(`/platform/crm/${organisationId}`);
  // The browse surface renders each organisation's name and location, so an
  // edit to either leaves a stale row there without this.
  revalidatePath("/platform/crm/organisations");
  return { ok: true };
}
