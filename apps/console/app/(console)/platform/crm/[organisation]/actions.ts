"use server";

import { revalidatePath } from "next/cache";
import { ESTATE } from "@tesserix/console-core";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import {
  advanceStage,
  assertNoSuppressedContact,
  logActivity,
  linkConversion as linkConversionRow,
  MissingProductError,
  AlreadyLinkedError,
  SuppressedContactError,
  type AdvanceStageResult,
} from "@/lib/db/crm-repo";
import { listTemplates, templateContext } from "@/lib/db/crm-templates";
import {
  recordTemplatedDm,
  ContactUnavailableError,
  TemplateRenderRefusedError,
  TemplateUnavailableError,
} from "@/lib/db/crm-outreach";
import {
  MERGE_FIELDS,
  renderTemplate,
  UnknownMergeFieldError,
  type MergeFieldToken,
} from "@/lib/crm-merge-fields";
// `assertNoSuppressedContact` takes the query it should run on, so that the
// write path can hand it a transaction. This caller holds no transaction — a
// preview reads and stops — so it passes the pooled query explicitly rather
// than the function acquiring a default nothing else here would see.
import { tesserixQuery } from "@/lib/db/tesserix";
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
 * What a caller without the `crm` capability is told, whatever the truth is.
 * Shared by every refusal that must not distinguish "you may not" from "it is
 * not there" — see `previewTemplate`.
 */
const PREVIEW_UNAVAILABLE_MESSAGE = "That template preview is not available.";


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
 * The erasure's own result type, rather than the shared `CrmActionResult`.
 *
 * `{ ok: true }` is the wrong shape for this one action: an erasure can succeed
 * and still be UNFINISHED (#507 — outreach the operator edited before sending
 * holds text a human wrote, which `eraseContact` flags rather than destroys).
 * A caller that only checked `ok` would close the dialog on a request that is
 * not yet honoured, and the type is what stops it: `pendingRedaction` is not
 * optional, so a consumer has to have seen it to compile.
 *
 * A COUNT, never the ids and never the text. The caller's job is to stop and
 * tell a human; finding the rows is `crm_activities`' job, via the runbook
 * query. Putting anything richer here would start walking the very text the
 * erasure exists to get rid of back towards a screen.
 */
export type EraseContactResult =
  | { ok: true; pendingRedaction: number }
  | { ok: false; message: string };

/**
 * Erase a contact's identifying data (DPDP "forget me" — #213/#154). The
 * organisation, its opportunities and its activity log are not destroyed; see
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
 *
 * `pendingRedaction` is the third surface the residual appears on, and the
 * three are not redundant: the row stamp is what a query can find months later,
 * the audit summary is what the evidence trail records, and this is what the
 * operator standing at the dialog is told while they still have the request in
 * front of them. Each covers a failure of the other two — a stamp nobody
 * queries, an audit row nobody reads, a dialog nobody was looking at.
 */
export async function eraseContactAction(contactId: string): Promise<EraseContactResult> {
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
        // `pending_redaction` rides in the SAME row as `erased`, not a
        // separate audit action, and that is the point: #140 reads this row
        // as evidence the request was honoured, and a row that says "erased:
        // 1" while text derived from the erased columns is still on disk
        // overstates what happened. The two counts are one claim.
        //
        // Unlike `erased`, it is NOT zeroed on a repeat click. `erased: 0`
        // means "this call erased nothing new"; `pending_redaction` means
        // "this much is still outstanding right now", which is as true on the
        // second click as the first — see `activitiesPendingRedaction`.
        //
        // A count, per `AuditSummary`. The ids would not fit its shape and
        // should not: `console_audit_log` is the other table `eraseContact`
        // cannot reach, so it gets the number and nothing that could grow
        // into the text.
        summary: {
          erased: outcome && !alreadyErased ? 1 : 0,
          pending_redaction: outcome ? outcome.activitiesPendingRedaction.length : 0,
        },
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
  return { ok: true, pendingRedaction: result.value?.activitiesPendingRedaction.length ?? 0 };
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

/* ────────────────────────────────────────────────────────────────────────────
 * LEAD-TEMPLATE PREVIEW (#LDQ)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a preview can come back as. A DISCRIMINATED UNION, NEVER A PARTIAL:
 * there is no branch that carries both `text` and a complaint, because the
 * only way to stop a caller shipping a half-rendered message is to not hand
 * it one. `renderTemplate` makes the same choice for the same reason, and
 * this type is that contract carried up to the composer intact rather than
 * flattened into `{ text, error }` at the action boundary.
 *
 * Each failure carries BOTH a machine field and a `message`. The message is
 * what the operator reads; `missing`/`unknown` exist so the composer can
 * highlight the offending fields without parsing prose.
 */
export type PreviewTemplateResult =
  | { ok: true; text: string; subject?: string }
  | { ok: false; reason: "suppressed"; message: string }
  | { ok: false; reason: "missing-fields"; missing: string[]; message: string }
  | { ok: false; reason: "unknown-fields"; unknown: string[]; message: string }
  | { ok: false; reason: "not-found" | "erased"; message: string };

export interface PreviewTemplateInput {
  organisationId: string;
  contactId: string;
  templateId: string;
}

/**
 * `renderTemplate` types `missing` as `string[]`, not `MergeFieldToken[]`,
 * because `unknown` shares the shape and cannot be narrowed. At runtime every
 * entry in `missing` came from the allowlist scan and is therefore a real
 * token — but "is therefore" is an argument, not a guarantee, and indexing
 * `MERGE_FIELDS` on the strength of one would break the day the renderer's
 * failure shapes are merged. This guard costs a line and makes the claim
 * checkable instead.
 */
function isMergeFieldToken(token: string): token is MergeFieldToken {
  return Object.hasOwn(MERGE_FIELDS, token);
}

/**
 * The refusal an operator can act on.
 *
 * IT NAMES THE FIELDS. An operator told only "cannot render" does the thing
 * this feature exists to remove: retypes the message by hand. Told "no bio
 * recorded for this contact", they pick another template or another lead in a
 * second. `MERGE_FIELDS[token].label` is the operator-facing wording and the
 * reason that registry carries a `label` at all.
 *
 * WHERE the data is missing changes the sentence, because "no location
 * recorded for this contact" would send the operator to the contact record to
 * look for a field that lives on the organisation. Three phrasings rather
 * than one generic "for this lead" is the difference between a message that
 * points somewhere and a message that only apologises.
 */
function missingFieldsMessage(missing: readonly string[]): string {
  const labels = missing
    .filter(isMergeFieldToken)
    .map((token) => MERGE_FIELDS[token].label);
  const names = labels.length > 0 ? labels.join(", ") : missing.join(", ");

  const scopes = new Set(missing.map((token) => token.split(".")[0]));
  const subject =
    scopes.size === 1 && scopes.has("org")
      ? "this organisation"
      : scopes.size === 1 && scopes.has("contact")
        ? "this contact"
        : "this lead";

  return `Cannot use this template: no ${names} recorded for ${subject}.`;
}

/**
 * Render one template against one lead, or refuse and say why.
 *
 * ══ THIS IS A READ, AND IT IS DELIBERATELY NOT `withCrmWrite` ══
 *
 * `withCrmWrite` wraps `auditedOperation`, and a preview is not an operation
 * worth an audit row. The composer calls this every time an operator changes
 * the template or the contact in a dropdown, so auditing it would write rows
 * at roughly the rate of a keystroke and bury the `crm.outreach.dm` rows that
 * record what was actually sent — an audit trail nobody can read is not an
 * audit trail. What IS audited is the send, in Task 7, which is the event
 * anyone querying this log is looking for.
 *
 * IT STILL NEEDS THE CAPABILITY GATE, because it returns
 * `crm_contacts.biography` — scrape-derived personal data that no other
 * console read exposes (see `crm-templates.ts`'s header). Dropping the audit
 * row is a decision about noise; dropping the gate would be a decision about
 * who can read a stranger's Instagram bio through our server. So
 * `checkOperatorCapabilityLive` is called directly here rather than inherited
 * from a wrapper this function does not use.
 *
 * ══ THE ORDER OF THE THREE STEPS IS LOAD-BEARING ══
 *
 * 1. SUPPRESSION FIRST, BEFORE ANY RENDER. A suppressed person's message is
 *    not produced at all — not produced and discarded, not produced and
 *    hidden behind a disabled button: never produced. Rendering first and
 *    refusing afterwards would put the text in this process's memory, in the
 *    action's return path, and one careless `console.log` or error report
 *    away from existing somewhere, for someone who asked us to stop. The CSV
 *    import already holds this at BOTH ends (`previewImport` and
 *    `commitImport` both call `isSuppressed` — "a preview is a promise about
 *    a state that may already be old"), and this surface takes the same
 *    shape: refused here, refused AGAIN inside Task 7's transaction.
 *
 *    `assertNoSuppressedContact` rather than a per-contact `isSuppressed`,
 *    even though this preview is about one chosen contact, because that is
 *    exactly the function the write path re-checks with. A preview that
 *    scoped the check more narrowly than the commit would pass here and throw
 *    there, and the operator would meet the refusal only after clicking the
 *    control that copies to their clipboard — the one moment the two ends
 *    disagreeing is most expensive.
 *
 * 2. THEN `templateContext`, which already excludes `erased_at IS NOT NULL`.
 *    That is why a contact erased between the page render and this call comes
 *    back as `erased` rather than rendering "Hi [erased]" into a greeting —
 *    `eraseContact` writes that literal string into `name`, so an erased
 *    contact sails through every null check in this feature. The exclusion in
 *    the read is the only thing that catches it.
 *
 * 3. THEN `renderTemplate`, whose all-or-nothing contract is the only reason
 *    the `missing-fields` branch below is reachable at all. A renderer that
 *    substituted "" would return `ok: true` here forever.
 */
export async function previewTemplate(
  input: PreviewTemplateInput,
): Promise<PreviewTemplateResult> {
  const session = await getCurrentSession();
  try {
    await checkOperatorCapabilityLive(session, "crm");
  } catch (cause) {
    if (!(cause instanceof CapabilityError)) throw cause;
    // `not-found`, not a distinct "forbidden", and not the wrapper's "you
    // don't have permission". An operator without `crm` should not learn from
    // this response whether the organisation, the contact or the template
    // exists — every one of those is a fact about the lead list, which is the
    // thing the capability gates. The composer is not rendered for them
    // anyway, so this is the hand-crafted-request case.
    return { ok: false, reason: "not-found", message: PREVIEW_UNAVAILABLE_MESSAGE };
  }

  return renderForLead(input);
}

/**
 * The three steps above, WITHOUT the session gate — shared by `previewTemplate`
 * and by `copyAndLogDm`'s server-side re-render.
 *
 * SHARED RATHER THAN COPIED, and that is the point. `copyAndLogDm` decides
 * whether `crm_activities.body` receives text by comparing the submitted string
 * to this render (see `crm-outreach.ts`). If the two paths rendered through
 * separate code, the comparison would be against a string this console might
 * not actually have produced, and the day the two copies stopped agreeing —
 * one commit is enough, per the `crm-identity.ts` lesson — every verbatim send
 * would start classifying itself as "edited" and storing the biography. The
 * defence only works if the preview and the check are literally the same
 * render.
 *
 * THE GATE IS NOT IN HERE, deliberately. `previewTemplate` calls
 * `checkOperatorCapabilityLive` itself before this runs; `copyAndLogDm` gets
 * the same check from `withCrmWrite`, INSIDE `auditedOperation`, so a refusal
 * is written as a `capability.refused` row (#409). Folding the gate in here
 * would move the write path's check outside `auditedOperation` and lose that
 * row — a deliberate refusal made indistinguishable from a request never made.
 */
async function renderForLead(input: PreviewTemplateInput): Promise<PreviewTemplateResult> {
  // Step 1. Before the template is even loaded: nothing about a suppressed
  // organisation is worth a second query.
  try {
    await assertNoSuppressedContact(input.organisationId, tesserixQuery);
  } catch (cause) {
    if (!(cause instanceof SuppressedContactError)) throw cause;
    // Not `cause.message`: that one ends "remove the suppression before
    // logging outreach", which is the instruction for the WRITE path. Here
    // the operator has not tried to log anything, and the fact worth telling
    // them is that no message exists to copy.
    return {
      ok: false,
      reason: "suppressed",
      message:
        "This organisation is on the do-not-contact list. No message was rendered for it.",
    };
  }

  // Live templates only. An archived one is not offered by the composer, so
  // reaching this with its id means the page was open while someone retired
  // it — and `not-found` is the honest answer: the copy was deliberately
  // withdrawn, and rendering it anyway would be the failure archiving exists
  // to prevent.
  const templates = await listTemplates();
  const template = templates.find((row) => row.id === input.templateId);
  if (!template) {
    return {
      ok: false,
      reason: "not-found",
      message: "That template is no longer available.",
    };
  }

  // Step 2.
  const context = await templateContext(input.organisationId);
  if (!context) {
    return {
      ok: false,
      reason: "not-found",
      message: "That organisation is no longer available.",
    };
  }

  // Scoped to the organisation the caller named, so a `contactId` belonging
  // to a different organisation resolves to nothing rather than to a contact
  // (T-LDQ-03). The list is already erasure-filtered, so "absent" covers both
  // "erased" and "not yours" — and the two deliberately share a message,
  // because distinguishing them would answer the question the scoping exists
  // to refuse.
  const contact = context.contacts.find((row) => row.id === input.contactId);
  if (!contact) {
    return {
      ok: false,
      reason: "erased",
      message: "That contact is no longer available. It may have been erased.",
    };
  }

  // Step 3.
  const rendered = renderTemplate({
    body: template.body,
    subject: template.subject,
    values: {
      "org.name": context.organisation.name,
      "org.location": context.organisation.location,
      "org.category": [...context.organisation.category],
      "contact.name": contact.name,
      "contact.instagram_handle": contact.instagramHandle,
      "contact.biography": contact.biography,
    },
  });

  if (!rendered.ok) {
    // UNKNOWN OUTRANKS MISSING, the same precedence `renderTemplate` itself
    // applies: an unknown token is broken for EVERY lead, so reporting this
    // lead's absent bio first would send the operator to the next lead to hit
    // the identical wall. (`renderTemplate` never returns both, so this is a
    // narrowing rather than a choice — but the precedence is why its union is
    // shaped that way, and it belongs written down at the surface that
    // renders the sentence.)
    if ("unknown" in rendered) {
      return {
        ok: false,
        reason: "unknown-fields",
        unknown: rendered.unknown,
        // Reusing `UnknownMergeFieldError`'s message rather than composing a
        // second one: the authoring form and this preview must name a bad
        // token identically, or an operator who sees both learns they are two
        // different problems.
        message: new UnknownMergeFieldError(rendered.unknown).message,
      };
    }
    return {
      ok: false,
      reason: "missing-fields",
      missing: rendered.missing,
      message: missingFieldsMessage(rendered.missing),
    };
  }

  return rendered.subject === undefined
    ? { ok: true, text: rendered.text }
    : { ok: true, text: rendered.text, subject: rendered.subject };
}

/* ────────────────────────────────────────────────────────────────────────────
 * COPY AND LOG (#LDQ)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CopyAndLogDmInput {
  organisationId: string;
  contactId: string;
  templateId: string;
  /**
   * What the operator is about to paste — the textarea's contents, which may
   * be our render untouched or their own rewrite of it. UNTRUSTED: it crosses
   * the browser → server boundary, and it is the only free text this feature
   * accepts. Whether it is ours or theirs is decided below, by re-rendering;
   * the client never says.
   */
  submittedText: string;
}

/**
 * The two allowlisted exceptions on the copy-and-log path.
 *
 * `SuppressedContactError` is the do-not-contact list refusing outreach at the
 * transaction's own re-check, and its message is already operator-facing.
 * `TemplateRenderRefusedError` carries the preview's wording for a render that
 * has stopped being possible (the bio was cleared, the template archived)
 * between the preview and the click. `TemplateUnavailableError` and
 * `ContactUnavailableError` come through the same door for the same reason:
 * each is a specific, actionable fact about a lead the operator is looking at,
 * and every one of them would otherwise surface as "That change was not saved."
 * and read as a bug in a feature that had in fact worked correctly.
 *
 * An allowlist, per exception type — never "anything that is an Error".
 */
function mapOutreachRefusal(cause: unknown): { ok: false; message: string } | undefined {
  if (
    cause instanceof SuppressedContactError ||
    cause instanceof TemplateRenderRefusedError ||
    cause instanceof TemplateUnavailableError ||
    cause instanceof ContactUnavailableError
  ) {
    return { ok: false, message: cause.message };
  }
  return undefined;
}

/**
 * Log that a templated DM was sent, and move everything sending one implies.
 *
 * ══ THE RE-RENDER IS WHAT DECIDES `body`, NOT THE CLIENT ══
 *
 * This action re-renders the template from `templateId` plus the LIVE contact
 * row (`renderForLead`, the same code the preview ran) and compares that string
 * to `submittedText`. Identical → the operator sent our render → `bodyIfEdited`
 * is null → `crm_activities.body` stays NULL. Different → the text is theirs
 * and is stored.
 *
 * The alternative — an `edited: boolean` on the request — was rejected outright
 * rather than merely disliked. A caller that claimed `edited: true` while
 * submitting the verbatim render would write `crm_contacts.biography` into
 * `crm_activities.body`, which is the one table `eraseContact` does not reach;
 * see `crm-outreach.ts`'s header for why that is a compliance defect rather
 * than a leak of no consequence. `body` is the only door in this feature that
 * accepts free text, so a client flag on it would defeat every other control at
 * once. `metadata.edited` is still recorded — derived here, never read from the
 * request.
 *
 * COMPARED EXACTLY, not trimmed or normalised. The asymmetry is deliberate: a
 * false "unedited" verdict stores LESS than the truth (nothing), while a false
 * "edited" verdict stores our render — including the biography — under the
 * banner of the operator's own words. Exact equality is the only comparison
 * that can never produce the second, and an operator whose sole edit was a
 * trailing space keeps their text stored, which costs nothing.
 *
 * ══ THE REFUSAL IS THROWN, NOT RETURNED ══
 *
 * A render that has stopped being possible since the preview must abort the
 * write, and inside `withCrmWrite` the only way to abort is to throw:
 * returning a value would have `auditedOperation` write a `crm.outreach.dm`
 * row claiming a DM was logged when none was.
 */
export async function copyAndLogDm(input: CopyAndLogDmInput): Promise<CrmActionResult> {
  const result = await withCrmWrite(
    input.contactId,
    { capability: "crm" },
    async (actor) => {
      const rendered = await renderForLead({
        organisationId: input.organisationId,
        contactId: input.contactId,
        templateId: input.templateId,
      });
      if (!rendered.ok) throw new TemplateRenderRefusedError(rendered.message);

      return recordTemplatedDm({
        organisationId: input.organisationId,
        contactId: input.contactId,
        templateId: input.templateId,
        bodyIfEdited: input.submittedText === rendered.text ? null : input.submittedText,
        actor: actor.email,
      });
    },
    (outcome) => ({
      action: "crm.outreach.dm",
      // Counts only, per `AuditSummary`. `edited` is carried as 1/0 rather
      // than omitted, because "was this row's text authored by a human" is
      // exactly the question an erasure request has to ask of this log.
      summary: { logged: 1, edited: outcome.edited ? 1 : 0 },
      // The handle or the email — NEVER the message text. The message embeds
      // the biography, and `console_audit_log` is another table `eraseContact`
      // does not reach: putting the render here would reintroduce, through the
      // audit row, precisely what `crm_activities.body` was kept clean of.
      // The id alongside it, Ruling 20-style, so the row can still be joined
      // back to a contact whose handle later changes.
      target: `${outcome.contactLabel ?? "(no handle or email on file)"} (${input.contactId})`,
    }),
    mapOutreachRefusal,
  );
  if (!result.ok) return result;
  revalidatePath(`/platform/crm/${input.organisationId}`);
  // The queue and the browse list both read `next_action_at` and
  // `last_contacted_at`, and a lead that just moved `new` → `contacted` is
  // gone from the stage-`new` working set this feature exists to clear.
  revalidatePath("/platform/crm");
  return { ok: true };
}
