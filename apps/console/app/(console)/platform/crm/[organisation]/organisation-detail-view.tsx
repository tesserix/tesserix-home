"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  CalloutDescription,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";
import { DestructiveConfirmDialog } from "@/components/kit/destructive-confirm-dialog";
import { CRM_STAGES, requiresProduct, type CrmStage } from "@/lib/crm";
import { MAX_VOID_REASON_LENGTH } from "@/lib/crm-void-reason";
import type {
  ActivityRow,
  ContactRow,
  OpportunityRow,
} from "@/lib/db/crm-repo";
import type { TemplateRow } from "@/lib/db/crm-templates";
import { NO_PRODUCT_VALUE } from "@/lib/db/crm-filters";
import {
  contactSourceLabel,
  lawfulBasisLabel,
} from "@/lib/crm-provenance";
import {
  KEEP_RECORDED_BASIS,
  LawfulBasisHint,
  LawfulBasisSelect,
} from "@/components/kit/lawful-basis-select";
import { formatFollowers, followersTitle } from "../followers";
import { ActivityComposer } from "./activity-composer";
import { TemplateComposer } from "./template-composer";
import { ErrorNote } from "./error-note";
import {
  addContactAction,
  updateContactAction,
  setPrimaryContactAction,
  changeStage,
  createOpportunityAction,
  deleteOrganisationAction,
  eraseContactAction,
  scheduleNextAction,
  voidOpportunityAction,
  restoreOpportunityAction,
} from "./actions";

const STAGE_LABELS: Record<CrmStage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  won: "Won",
  lost: "Lost",
};

interface ProductOption {
  context: string;
  name: string;
}

/**
 * `eraseContact` writes `'[erased]'` into `crm_contacts.name` as a database
 * tombstone (crm-erasure.ts) — a value chosen to be unambiguous in SQL, not
 * to be read by an operator. Rendered verbatim it produces UI copy like
 * "Erase [erased]?", which reads as a bug. Mapped to a human display string
 * here, at the row, so the tombstone stays exactly what the database needs
 * it to be.
 */
function displayContactName(name: string | null): string {
  if (name === "[erased]") return "Erased contact";
  return name ?? "Unnamed contact";
}

/**
 * The typed-confirmation gate both hard-delete controls below sit behind.
 *
 * Not `window.confirm`: it blocks the render thread, and there is no way to
 * recover if a browser extension or a slow tab leaves it stuck — see #213.
 * Typing the organisation's name is the same "make the operator stop and
 * read" friction, fully keyboard-operable and recoverable, and it works for
 * contact erasure too — asking someone to retype a person's own name back at
 * them, right after telling them it's about to be erased, is an odd ask; the
 * organisation's name is the stable thing both actions share.
 *
 * Compared case-insensitively (after trimming): requiring exact case is
 * friction with no safety benefit — it produces a disabled button and no
 * stated reason a sighted operator can even see, let alone a screen-reader
 * one. Still requires the full name, not a prefix.
 *
 * This is the client-side defence against a slip of the mouse, not the
 * authorization control — `hard-delete` on the server is that, checked
 * again by `withCrmWrite` regardless of what this dialog does.
 */
function useTypedConfirmation(expected: string) {
  const [value, setValue] = useState("");
  const normalised = value.trim().toLowerCase();
  return { value, setValue, matches: normalised.length > 0 && normalised === expected.toLowerCase() };
}

function ConfirmTypedName({
  id,
  statusId,
  organisationName,
  value,
  matches,
  onChange,
  error,
}: {
  id: string;
  statusId: string;
  organisationName: string;
  value: string;
  matches: boolean;
  onChange: (value: string) => void;
  error: string | null;
}) {
  return (
    <div className="mt-2">
      <Label htmlFor={id}>
        Type <span className="font-medium">{organisationName}</span> to confirm (not
        case-sensitive)
      </Label>
      <Input
        id={id}
        className="mt-1"
        value={value}
        autoComplete="off"
        aria-describedby={statusId}
        onChange={(event) => onChange(event.target.value)}
      />
      {/* `aria-live` announces the reason the confirm button below is
          unreachable — and the moment it stops being unreachable — to a
          screen-reader operator who can already see the button is disabled
          but not why. */}
      <p id={statusId} aria-live="polite" className="mt-1 text-xs text-muted-foreground">
        {matches
          ? "Name matches. The confirm button is enabled."
          : `Confirm button is disabled until this matches "${organisationName}".`}
      </p>
      <ErrorNote message={error} />
    </div>
  );
}


/**
 * A contact's "forget me" control (DPDP erasure — #213/#154).
 *
 * Overwrites the person's identifying details and keeps everything else:
 * the organisation, its opportunities, and the activity log the funnel
 * measurement depends on. Rendered only when the session holds
 * `hard-delete` — see `ContactsTab`'s caller in `page.tsx` — because a
 * control the operator cannot use is worse than no control at all: it
 * invites them through a confirmation only to hit a permission error on the
 * other side of it.
 */
function EraseContactButton({
  organisationName,
  contact,
}: {
  organisationName: string;
  contact: ContactRow;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { value, setValue, matches } = useTypedConfirmation(organisationName);

  // Non-null once an erasure has come back reporting outreach it could not
  // finish (#507). Held in state rather than shown as a toast because the
  // operator has to be able to read a count, a contact id and an instruction
  // off it — and because a notice that disappears on its own is the same
  // control as no notice, for an obligation with a deadline.
  const [unfinished, setUnfinished] = useState<number | null>(null);

  const reset = () => {
    setValue("");
    setError(null);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await eraseContactAction(contact.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      reset();
      // The refresh happens either way — the erasure itself DID commit, and
      // leaving the person's details on screen while the operator reads about
      // the residual would be its own defect.
      router.refresh();
      // Replaces one modal with another rather than returning the operator to
      // the page. The erasure is not finished, they are the only one who can
      // finish it, and this is the last moment they are certain to be looking.
      if (result.pendingRedaction > 0) setUnfinished(result.pendingRedaction);
    });
  };

  // `[erased]` is the database tombstone, never a display string — see
  // `displayContactName`. Not reading it here would produce "Erase [erased]?".
  const contactLabel = displayContactName(contact.name);
  const statusId = `erase-confirm-status-${contact.id}`;

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Erase
      </Button>
      <DestructiveConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={`Erase ${contactLabel}?`}
        // Says up front that the erasure may not finish here (#507). An
        // operator who learns that only in the notice AFTERWARDS has already
        // decided; this is the screen where the decision is still theirs.
        description={`This overwrites ${contactLabel}'s name, email, phone, and Instagram handle. ${organisationName}'s deal history — its opportunities and activity log — is kept exactly as it is. Any DM an operator edited before sending keeps the words they wrote, so those may need redacting by hand afterwards; you will be told how many. This cannot be undone.`}
        confirmLabel="Erase contact"
        confirmId={`erase-confirm-button-${contact.id}`}
        statusId={statusId}
        loading={pending}
        confirmDisabled={!matches}
        onConfirm={submit}
      >
        <ConfirmTypedName
          id={`erase-confirm-${contact.id}`}
          statusId={statusId}
          organisationName={organisationName}
          value={value}
          matches={matches}
          onChange={setValue}
          error={error}
        />
      </DestructiveConfirmDialog>
      <UnfinishedErasureDialog
        contactId={contact.id}
        count={unfinished}
        onAcknowledge={() => setUnfinished(null)}
      />
    </>
  );
}

/**
 * What an operator is told when an erasure committed but did not finish
 * (#507).
 *
 * `eraseContact` cannot destroy the body of a DM the operator EDITED before
 * sending — that text is what a human actually wrote, and deleting it to get
 * at the quoted biography inside it would destroy the record of what was said
 * along with the part that had to go. It flags those rows instead and reports
 * how many; this is where a person is told.
 *
 * MODAL, AND WITH NO CANCEL. The other two surfaces (`metadata
 * .erasure_pending_review` on the rows, `pending_redaction` in the audit row)
 * are durable and survive this dialog being missed, so this one is not the
 * guarantee — but it is the only one that reaches the operator while the
 * request is still in their hands, and a toast at the bottom of a page they
 * are about to navigate away from would be indistinguishable from saying
 * nothing. There is nothing to cancel: the erasure already committed, so the
 * only honest control is an acknowledgement.
 *
 * NAMES NO PERSON AND SHOWS NO MESSAGE TEXT. The count and the contact id are
 * enough to run the runbook query, and the whole reason those rows are a
 * problem is that what they contain must not be reproduced anywhere new — a
 * dialog that helpfully previewed them would be the defect, on a new surface.
 */
function UnfinishedErasureDialog({
  contactId,
  count,
  onAcknowledge,
}: {
  contactId: string;
  count: number | null;
  onAcknowledge: () => void;
}) {
  return (
    <Dialog open={count !== null} onOpenChange={(next) => !next && onAcknowledge()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>This erasure is not finished</DialogTitle>
          <DialogDescription>
            The contact&apos;s details are gone, but {count} logged{" "}
            {count === 1 ? "message" : "messages"} an operator edited before sending{" "}
            {count === 1 ? "was" : "were"} kept — that text is what a human wrote, so it was
            flagged for review rather than deleted. It may still quote this person&apos;s
            profile.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p>
            Review and redact {count === 1 ? "it" : "them"} by hand today. The request is not
            honoured until you have.
          </p>
          <p className="text-muted-foreground">
            Follow &ldquo;Honouring a DPDP erasure request&rdquo; in{" "}
            <code>.planning/OPERATOR-RUNBOOK.md</code>. Contact id: <code>{contactId}</code>
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            id={`erase-unfinished-ack-${contactId}`}
            onClick={onAcknowledge}
          >
            I will redact them
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The organisation-level delete control (DPDP "this business should not
 * exist here" — #213/#154, distinct from erasure: a true cascade over the
 * organisation, its contacts, its opportunities and its activities).
 *
 * Rendered by the page header, not this file's tab content, but defined
 * here alongside `EraseContactButton` since both share the typed-confirmation
 * gate above. Same `hard-delete` gate as the erase control — see that
 * comment for why hiding beats a post-confirmation permission error.
 */
export function DeleteOrganisationButton({
  organisationId,
  organisationName,
}: {
  organisationId: string;
  organisationName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { value, setValue, matches } = useTypedConfirmation(organisationName);
  const statusId = "delete-organisation-confirm-status";

  const reset = () => {
    setValue("");
    setError(null);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteOrganisationAction(organisationId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // The organisation this page is showing no longer exists — back to
      // the list, not a refresh of a page with nothing left to render.
      router.push("/platform/crm");
      router.refresh();
    });
  };

  return (
    <>
      <Button type="button" size="sm" variant="destructive" onClick={() => setOpen(true)}>
        Delete organisation
      </Button>
      <DestructiveConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={`Delete ${organisationName}?`}
        description={`This removes ${organisationName} and every opportunity and activity recorded against it — unlike erasing a contact, there is no deal history left afterwards. This cannot be undone.`}
        confirmLabel="Delete organisation"
        confirmId="delete-organisation-confirm-button"
        statusId={statusId}
        loading={pending}
        confirmDisabled={!matches}
        onConfirm={submit}
      >
        <ConfirmTypedName
          id="delete-organisation-confirm"
          statusId={statusId}
          organisationName={organisationName}
          value={value}
          matches={matches}
          onChange={setValue}
          error={error}
        />
      </DestructiveConfirmDialog>
    </>
  );
}

/**
 * What to call a deal on screen.
 *
 * A `crm_opportunities` row has no name of its own — the product is the only
 * operator-visible thing that tells one of an organisation's deals from
 * another — and `product` holds a context key (`"mark8ly"`), not a label, so
 * the estate is consulted for the readable name. Falls back to the raw key
 * for a product the estate no longer lists, which is a deal that still has to
 * be identifiable rather than blank.
 *
 * Null when the deal has no product at all. That is not an error state — it
 * is every deal before `qualified` — so callers render the absence in their
 * own words rather than being handed a placeholder.
 *
 * Not a copy of `productLabel` in `../product-label.ts`, whose own comment
 * warns against exactly that — and the two differ in both halves. It returns
 * the string "Unassigned" for a null product, which is the right answer in a
 * queue column but the wrong one here: the card below says "No product yet"
 * in its heading, so the caller has to word the absence and this returns
 * null. And it reads `ESTATE` directly, which this file — a client component
 * — instead takes as the `products` prop `page.tsx` already passes it. If
 * those two differences ever collapse, delete this one and import that.
 */
function opportunityProductLabel(
  opportunity: OpportunityRow,
  products: readonly ProductOption[],
): string | null {
  if (!opportunity.product) return null;
  return products.find((p) => p.context === opportunity.product)?.name ?? opportunity.product;
}

/**
 * The deal as the operator can see it, for a control's accessible name.
 *
 * An organisation's cards carry identical controls and differ only by their
 * product, so a bare "Void" names nothing a screen-reader operator could act
 * on. A productless deal is genuinely indistinguishable from another
 * productless deal on the same organisation — that is true of the whole card,
 * not just these controls — so this says what is known rather than inventing
 * an identity.
 */
function dealLabelFor(productLabel: string | null): string {
  return productLabel ?? "no product yet";
}

/**
 * Take one deal out of the funnel (#251).
 *
 * Deliberately NOT a fourth entry in the stage `<select>` above: a
 * destructive-looking option one keystroke away from "Won" in a list an
 * operator flicks through is the mis-click hazard this issue exists to
 * remove, not one to add. It is its own button, behind its own confirmation.
 *
 * No typed-name gate, unlike the organisation delete and the contact erasure.
 * Those destroy a whole business record or a person's details; this destroys
 * nothing at all and `RestoreOpportunityButton` below undoes it. The tool
 * deletes (`components/tools-admin/tools-manager.tsx`) sit in the same class
 * and do not type-gate either. `DestructiveConfirmDialog` supports a caller
 * with no gate — `statusId` is optional — and the confirmation's job here is
 * to make the operator read what a void actually does, which most of them
 * have never seen before.
 *
 * Gated on `crm`, matching `voidOpportunityAction`: a control that walks an
 * operator through a confirmation and then refuses is worse than no control.
 * Its caller applies the same rule a second time and withholds it from a
 * grandfathered row, which `voidOpportunity` refuses for a reason no
 * capability check covers.
 */
function VoidOpportunityButton({
  opportunity,
  productLabel,
}: {
  opportunity: OpportunityRow;
  /** From `opportunityProductLabel` — null for a deal with no product. */
  productLabel: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const dealLabel = dealLabelFor(productLabel);
  const reasonId = `void-reason-${opportunity.id}`;

  const reset = () => {
    setError(null);
    setReason("");
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      // Trimmed to null rather than sent as "": the column takes a reason or
      // nothing, and whitespace is nothing. `voidOpportunity` trims what it
      // does store, so this measures the same string the cap applies to.
      const result = await voidOpportunityAction(opportunity.id, reason.trim() || null);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      reset();
      // Unconditional, and this is the reason: an already-voided deal is a
      // reported no-op, not a failure, and it revalidates the same paths —
      // but the card the operator clicked from is the one showing a live
      // deal the database says is already voided, so it is exactly the card
      // that needs re-reading.
      router.refresh();
    });
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        // The visible label says what the button does; the accessible name
        // adds which deal. Kept as a prefix so speaking the visible words
        // still activates it.
        aria-label={`Void deal: ${dealLabel}`}
        onClick={() => setOpen(true)}
      >
        Void deal
      </Button>
      <DestructiveConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={`Void the ${dealLabel} deal?`}
        // Says what a void DOES and what SURVIVES — the same discipline the
        // organisation delete and the contact erasure follow, and it is more
        // literally true here than in either of those: nothing is destroyed.
        // The activity trail is the least obvious of the three facts and the
        // one an operator is most likely to fear losing, so it is named.
        description={`This takes the deal out of every work queue and stops it counting towards close rates. Nothing is deleted — its whole activity trail stays attached to it, and you can restore it later.`}
        confirmLabel="Void deal"
        confirmId={`void-opportunity-confirm-button-${opportunity.id}`}
        loading={pending}
        onConfirm={submit}
      >
        <div className="space-y-1">
          <Label htmlFor={reasonId}>Reason (optional)</Label>
          <Input
            id={reasonId}
            value={reason}
            disabled={pending}
            // The same cap `voidOpportunityAction` enforces, from the same
            // constant, so the field refuses the 501st character rather than
            // the round trip refusing the whole reason after the operator
            // has written it. The action still checks — this is the
            // convenience, not the rule.
            maxLength={MAX_VOID_REASON_LENGTH}
            placeholder="Duplicate of the other deal"
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Kept on the deal and on the organisation&apos;s timeline, for whoever reads
            this next.
          </p>
        </div>
        <ErrorNote message={error} />
      </DestructiveConfirmDialog>
    </>
  );
}

/**
 * Put a voided deal back in the funnel (#251).
 *
 * No confirmation: restoring destroys nothing and undoes nothing an operator
 * cannot immediately void again, so a dialog here would be friction with no
 * decision behind it. The void has one because a void is the surprising
 * direction.
 *
 * No reason field either. A second void with a different reason is a
 * reported no-op that silently keeps the FIRST reason, so the only place a
 * reason can be given is the void that actually records one — offering the
 * field twice would imply an edit this path cannot perform.
 */
function RestoreOpportunityButton({
  opportunity,
  productLabel,
}: {
  opportunity: OpportunityRow;
  productLabel: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dealLabel = dealLabelFor(productLabel);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await restoreOpportunityAction(opportunity.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Restore deal: ${dealLabel}`}
        disabled={pending}
        onClick={submit}
      >
        {pending ? "Restoring…" : "Restore deal"}
      </Button>
      <ErrorNote message={error} />
    </div>
  );
}

/**
 * One opportunity's stage control.
 *
 * A grandfathered opportunity — migrated to qualified/won/lost with no
 * product (migration 0021) — cannot take ANY write until a product is
 * supplied, so the product field is always shown for it (not only when the
 * target stage is being changed), pre-filled with nothing to force an
 * explicit choice rather than a guess. `requiresProduct` mirrors the CHECK,
 * so this shows the field exactly when the database would otherwise reject
 * the write.
 */
function OpportunityCard({
  organisationId,
  opportunity,
  products,
  canCrm,
}: {
  organisationId: string;
  opportunity: OpportunityRow;
  products: readonly ProductOption[];
  canCrm: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<CrmStage>(opportunity.stage);
  const [product, setProduct] = useState(opportunity.product ?? "");
  const [lostReason, setLostReason] = useState(opportunity.lostReason ?? "");
  const [nextActionAt, setNextActionAt] = useState(
    opportunity.nextActionAt ? opportunity.nextActionAt.slice(0, 16) : "",
  );
  const [nextActionNote, setNextActionNote] = useState(opportunity.nextActionNote ?? "");

  const isGrandfathered = requiresProduct(opportunity.stage) && !opportunity.product;
  const targetNeedsProduct = requiresProduct(stage) || isGrandfathered;
  const productLabel = opportunityProductLabel(opportunity, products);
  const isVoided = opportunity.voidedAt !== null;

  const submitStage = () => {
    setError(null);
    startTransition(async () => {
      const result = await changeStage({
        organisationId,
        opportunityId: opportunity.id,
        to: stage,
        product: targetNeedsProduct ? product || undefined : undefined,
        lostReason: stage === "lost" ? lostReason || undefined : undefined,
      });
      if (!result.ok) {
        setError(result.message);
      }
      router.refresh();
    });
  };

  const submitNextAction = () => {
    setError(null);
    startTransition(async () => {
      const result = await scheduleNextAction({
        organisationId,
        opportunityId: opportunity.id,
        at: nextActionAt ? new Date(nextActionAt).toISOString() : null,
        note: nextActionNote || null,
      });
      if (!result.ok) {
        setError(result.message);
      }
      router.refresh();
    });
  };

  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={opportunity.stage === "won" ? "default" : "secondary"}>
            {STAGE_LABELS[opportunity.stage]}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {productLabel ?? "No product yet"}
          </span>
          {opportunity.owner ? (
            <span className="text-sm text-muted-foreground">· {opportunity.owner}</span>
          ) : null}
          {/* The voided state as a WORD, not a colour or a struck-through
              card: the stage badge beside it still reads "Qualified", and
              nothing else on the row contradicts it. */}
          {isVoided ? <Badge variant="outline">Voided</Badge> : null}
        </div>
        {/* No Void control on a grandfathered row. `voidOpportunity` refuses
            one with `MissingProductError` (crm-void.ts) — 0021's CHECK is
            re-evaluated by the void's own UPDATE — so offering the button
            would walk the operator through a confirmation and then refuse,
            the exact thing `VoidOpportunityButton`'s own docstring above
            declines to do. The callout below says so instead. Restore is
            unaffected: a grandfathered row cannot become voided in the first
            place, so `isVoided` and `isGrandfathered` are never both true
            for a deal this console voided. */}
        {canCrm ? (
          isVoided ? (
            <RestoreOpportunityButton opportunity={opportunity} productLabel={productLabel} />
          ) : isGrandfathered ? null : (
            <VoidOpportunityButton opportunity={opportunity} productLabel={productLabel} />
          )
        ) : null}
      </div>

      {isVoided ? (
        // Not `destructive`: a voided deal is a corrected record, not a
        // fault. Says why the controls below refuse — `advanceStageOnQuery`
        // and `setNextAction` raise `VoidedOpportunityError` for this row,
        // and they are still on screen because this page is the
        // organisation's file rather than a work queue.
        <Callout className="mt-3">
          <CalloutDescription>
            This deal is out of every work queue and is not counted towards close rates.
            Its activity is still recorded against it. Restore it before changing its
            stage or scheduling a next action.
            {opportunity.voidedReason ? ` Reason given: ${opportunity.voidedReason}` : ""}
          </CalloutDescription>
        </Callout>
      ) : null}

      {isGrandfathered ? (
        <Callout variant="destructive" className="mt-3">
          <CalloutDescription>
            This opportunity was migrated from the old CRM without a product. It cannot be
            edited — including scheduling a next action — until a product is assigned below.
            It cannot be voided either, for the same reason. Assign the product this deal
            was genuinely for: the organisation&rsquo;s product list and the product filter
            both count voided deals, so a product picked only to unblock a void would stay
            on this business&rsquo;s record as a deal that never happened.
          </CalloutDescription>
        </Callout>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor={`stage-${opportunity.id}`}>
            Stage
          </label>
          <select
            id={`stage-${opportunity.id}`}
            className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={stage}
            disabled={pending}
            onChange={(event) => setStage(event.target.value as CrmStage)}
          >
            {CRM_STAGES.map((value) => (
              <option key={value} value={value}>
                {STAGE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        {targetNeedsProduct ? (
          <div>
            <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor={`product-${opportunity.id}`}>
              Product
            </label>
            <select
              id={`product-${opportunity.id}`}
              className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={product}
              disabled={pending}
              onChange={(event) => setProduct(event.target.value)}
            >
              <option value="">Choose a product…</option>
              {products.map((p) => (
                <option key={p.context} value={p.context}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {stage === "lost" ? (
          <div>
            <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor={`lost-reason-${opportunity.id}`}>
              Lost reason
            </label>
            <input
              id={`lost-reason-${opportunity.id}`}
              className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={lostReason}
              disabled={pending}
              onChange={(event) => setLostReason(event.target.value)}
            />
          </div>
        ) : null}

        <Button type="button" size="sm" disabled={pending} onClick={submitStage}>
          {pending ? "Saving…" : "Save stage"}
        </Button>
      </div>

      {!isGrandfathered ? (
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div>
            <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor={`next-at-${opportunity.id}`}>
              Next action
            </label>
            <input
              id={`next-at-${opportunity.id}`}
              type="datetime-local"
              className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={nextActionAt}
              disabled={pending}
              onChange={(event) => setNextActionAt(event.target.value)}
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor={`next-note-${opportunity.id}`}>
              Note
            </label>
            <input
              id={`next-note-${opportunity.id}`}
              className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={nextActionNote}
              disabled={pending}
              onChange={(event) => setNextActionNote(event.target.value)}
            />
          </div>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={submitNextAction}>
            {pending ? "Saving…" : "Schedule"}
          </Button>
        </div>
      ) : null}

      <ErrorNote message={error} />
    </div>
  );
}

export function ActivityTab({
  organisationId,
  activities,
  hasMoreActivities,
  opportunities,
  contacts,
  templates,
}: {
  organisationId: string;
  activities: readonly ActivityRow[];
  /** True when the read hit its cap and older activity exists that
   *  `activities` does not contain — see `OrganisationDetail`. Without it the
   *  bottom of a capped timeline is indistinguishable from the bottom of the
   *  record. */
  hasMoreActivities: boolean;
  /** Passed only so the composer can offer a follow-up against a real deal
   *  once contact is logged (#245) — the timeline itself does not use them. */
  opportunities: readonly OpportunityRow[];
  /** `ContactRow`, not the renderer's `TemplateContactRow`: the composer needs
   *  a name for a dropdown, not a scraped biography. See
   *  `template-composer.tsx`. */
  contacts: readonly ContactRow[];
  /** Live `dm` templates. Empty is an ordinary state — the composer says so
   *  and points at the authoring surface. */
  templates: readonly TemplateRow[];
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* ABOVE the free-text composer, because for a stage-`new` lead the
          templated path is the common case and hand-writing the DM is the
          fallback — 259 of them is the reason this feature exists. */}
      <TemplateComposer
        organisationId={organisationId}
        templates={templates}
        contacts={contacts}
      />
      <ActivityComposer organisationId={organisationId} opportunities={opportunities} />
      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {activities.map((activity) => (
              <li key={activity.id} className="border-t border-border pt-3 text-sm">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{activity.actor}</span>
                  <span>{activity.kind.replace("_", " ")}</span>
                  <span>{new Date(activity.occurredAt).toLocaleString()}</span>
                </div>
                {activity.body ? <p className="mt-1">{activity.body}</p> : null}
              </li>
            ))}
          </ul>
          {hasMoreActivities ? (
            // Below the list and inside this branch, worded after
            // `handoff-view.tsx`: it describes what follows the rows the
            // operator has just read, and an empty timeline is not a
            // truncated one — the empty-state line would contradict it.
            // Not `destructive`: a long history is a record, not a fault.
            <Callout className="mt-1">
              <CalloutDescription>
                Showing the {activities.length} most recent. Older activity is not
                shown on this page.
              </CalloutDescription>
            </Callout>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Open a new opportunity against this organisation.
 *
 * Rendered whether or not `opportunities` is empty — the design's third
 * motivating case (crm-writes.ts) is exactly a returning organisation whose
 * last opportunity is long since won or lost, so this control has to be
 * reachable from a tab that may otherwise show nothing.
 */
function NewOpportunityForm({
  organisationId,
  products,
}: {
  organisationId: string;
  products: readonly ProductOption[];
}) {
  const router = useRouter();
  const [product, setProduct] = useState(NO_PRODUCT_VALUE);
  const [owner, setOwner] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createOpportunityAction({
        organisationId,
        product: product === NO_PRODUCT_VALUE ? undefined : product,
        owner: owner.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setProduct(NO_PRODUCT_VALUE);
      setOwner("");
      router.refresh();
    });
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <Label htmlFor="new-opportunity-product">Product</Label>
        <Select value={product} onValueChange={setProduct} disabled={pending}>
          <SelectTrigger id="new-opportunity-product" size="sm" className="mt-1 w-44">
            <SelectValue placeholder="Choose a product…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PRODUCT_VALUE}>No product yet</SelectItem>
            {products.map((p) => (
              <SelectItem key={p.context} value={p.context}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="new-opportunity-owner">Owner</Label>
        <Input
          id="new-opportunity-owner"
          className="mt-1 h-9"
          value={owner}
          disabled={pending}
          onChange={(event) => setOwner(event.target.value)}
        />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Opening…" : "New opportunity"}
      </Button>
      <ErrorNote message={error} />
    </form>
  );
}

export function OpportunitiesTab({
  organisationId,
  opportunities,
  products,
  canCrm,
}: {
  organisationId: string;
  opportunities: readonly OpportunityRow[];
  products: readonly ProductOption[];
  /** Whether the session holds `crm` — see `page.tsx`. Threaded to each card,
   *  which is where the void and restore controls live. Not `hard-delete`:
   *  a void destroys nothing, and `voidOpportunityAction` gates on `crm` for
   *  that reason. */
  canCrm: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <NewOpportunityForm organisationId={organisationId} products={products} />
      {opportunities.length === 0 ? (
        <p className="text-sm text-muted-foreground">No opportunities for this organisation yet.</p>
      ) : (
        opportunities.map((opportunity) => (
          <OpportunityCard
            key={opportunity.id}
            organisationId={organisationId}
            opportunity={opportunity}
            products={products}
            canCrm={canCrm}
          />
        ))
      )}
    </div>
  );
}

/**
 * Add a second contact to an existing organisation — the other half of the
 * manual-create door (#213). `organisations/new` covers the first contact on
 * a brand-new organisation; this covers every one after.
 */
function AddContactForm({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [instagramHandle, setInstagramHandle] = useState("");
  // #248: no default. See `LawfulBasisSelect`.
  const [lawfulBasis, setLawfulBasis] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Gates the only submitter below, which is the only way `submit` runs —
  // Enter in a field implicitly clicks that button, and a disabled button
  // submits nothing. So `submit` does not re-check; `addContactAction` does.
  const hasField = [name, email, phone, instagramHandle].some((value) => value.trim().length > 0);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await addContactAction({
        organisationId,
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        instagramHandle: instagramHandle.trim() || undefined,
        lawfulBasis,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setName("");
      setEmail("");
      setPhone("");
      setInstagramHandle("");
      // Cleared with the rest: the next contact is a separate decision.
      setLawfulBasis("");
      router.refresh();
    });
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <Label htmlFor="new-contact-name">Name</Label>
        <Input
          id="new-contact-name"
          className="mt-1 h-9"
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="new-contact-email">Email</Label>
        <Input
          id="new-contact-email"
          className="mt-1 h-9"
          type="email"
          value={email}
          disabled={pending}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="new-contact-phone">Phone</Label>
        <Input
          id="new-contact-phone"
          className="mt-1 h-9"
          value={phone}
          disabled={pending}
          onChange={(event) => setPhone(event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="new-contact-handle">Instagram handle</Label>
        <Input
          id="new-contact-handle"
          className="mt-1 h-9"
          value={instagramHandle}
          disabled={pending}
          placeholder="@bondibaker"
          onChange={(event) => setInstagramHandle(event.target.value)}
        />
      </div>
      <div className="min-w-48">
        <Label htmlFor="new-contact-lawful-basis">Lawful basis</Label>
        <div className="mt-1">
          <LawfulBasisSelect
            id="new-contact-lawful-basis"
            value={lawfulBasis || undefined}
            onValueChange={setLawfulBasis}
            disabled={pending}
          />
        </div>
        <LawfulBasisHint value={lawfulBasis || undefined} />
      </div>
      {/* Gated on the basis as well as on there being a field to save. The
          action refuses a missing one regardless; this is what keeps the
          refusal from being how the operator learns it was required. */}
      <Button type="submit" size="sm" disabled={pending || !hasField || !lawfulBasis}>
        {pending ? "Adding…" : "Add contact"}
      </Button>
      <ErrorNote message={error} />
    </form>
  );
}

/**
 * One contact, with its correction affordances.
 *
 * The edit form is collapsed by default. Contacts are a LIST — an
 * organisation can have several — and four always-open inputs per row would
 * turn a reference view into a wall of form fields, burying the thing an
 * operator usually comes here to read.
 */
function ContactRowItem({
  organisationId,
  organisationName,
  contact,
  canHardDelete,
}: {
  organisationId: string;
  organisationName: string;
  contact: ContactRow;
  canHardDelete: boolean;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <li className="border-t border-border pt-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{displayContactName(contact.name)}</span>
          {contact.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
        </div>
        <div className="flex items-center gap-2">
          {contact.isPrimary ? null : (
            <MakePrimaryButton organisationId={organisationId} contact={contact} />
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? "Cancel" : "Edit"}
          </Button>
          {canHardDelete ? (
            <EraseContactButton organisationName={organisationName} contact={contact} />
          ) : null}
        </div>
      </div>
      {editing ? (
        <EditContactForm
          organisationId={organisationId}
          contact={contact}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="mt-1 flex flex-wrap gap-3 text-muted-foreground">
            {contact.email ? <span>{contact.email}</span> : null}
            {contact.phone ? <span>{contact.phone}</span> : null}
            {contact.instagramHandle ? <span>{contact.instagramHandle}</span> : null}
            <ContactFollowers count={contact.followersCount} />
          </div>
          <ContactProvenance contact={contact} />
        </>
      )}
    </li>
  );
}

/**
 * The contact's follower count (#252 §A), abbreviated, on the same muted line
 * as the email and handle.
 *
 * On this page because the browse list bands and sorts organisations on this
 * number: an operator arrives here having filtered on it, and until now
 * opening a row dropped the one figure they were selecting for. Beside the
 * identifiers rather than in the provenance block below because it describes
 * the contact's reach, not our lawful basis for holding their details.
 *
 * A count of null renders NOTHING — not a `0`, and not a placeholder — which
 * is what the other entries on this line already do when absent. Those rows
 * have no recorded value, and `crm-filters.ts`'s `UNKNOWN_LABEL` explains why
 * that must not be shown as a measured zero: an operator would qualify a lead
 * out on a number nobody collected. (The browse list shows an em-dash instead
 * for the same absence, because a table cell has to occupy its column.)
 *
 * THE WORD "followers" IS RENDERED, unlike in the list's cell, and visibly
 * rather than as `sr-only` text. On the list a column header names the
 * number; here it sits between an email and an `@handle` with nothing to say
 * what it counts, and that ambiguity is not specific to assistive
 * technology — a sighted operator reading `12k` beside a handle has the same
 * question. `sr-only` is the right tool where the visual context already
 * carries the meaning, as in `ProductsCell`'s "+2 more"; it is the wrong one
 * here, where restoring the label for screen readers alone would leave
 * everyone else guessing. `title` still holds the exact figure, which is the
 * precision the abbreviation drops, not the identity of the number.
 *
 * `formatFollowers` and `followersTitle` are shared with that list so the two
 * surfaces cannot round the same contact differently.
 */
function ContactFollowers({ count }: { count: number | null }) {
  if (count === null) return null;

  return <span title={followersTitle(count)}>{formatFollowers(count)} followers</span>;
}

/**
 * What we hold about this person, when we got it, and why we may (#248).
 *
 * On the detail page and not behind the edit form, because this is the
 * surface an operator answering a subject-access request is already on:
 * migration 0019 wrote these three columns as "the justification for holding
 * the data at all" and nothing selected them, so until now the only way to
 * answer "why do you have my details" was psql.
 *
 * ALWAYS RENDERED, including when all three are null — which is exactly the
 * state #248 found for every contact created since the cutover. A block that
 * disappeared when there was nothing to show would hide the one case worth
 * seeing; "Not recorded" is a finding, not an empty state.
 */
function ContactProvenance({ contact }: { contact: ContactRow }) {
  return (
    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <div className="flex gap-1">
        <dt>Lawful basis:</dt>
        <dd className="font-medium">{lawfulBasisLabel(contact.lawfulBasis)}</dd>
      </div>
      <div className="flex gap-1">
        <dt>Source:</dt>
        <dd className="font-medium">{contactSourceLabel(contact.source)}</dd>
      </div>
      <div className="flex gap-1">
        <dt>Sourced:</dt>
        <dd className="font-medium">
          {contact.sourcedAt ? contact.sourcedAt.slice(0, 10) : "Not recorded"}
        </dd>
      </div>
    </dl>
  );
}

function MakePrimaryButton({
  organisationId,
  contact,
}: {
  organisationId: string;
  contact: ContactRow;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await setPrimaryContactAction(organisationId, contact.id);
            if (!result.ok) {
              setError(result.message);
              return;
            }
            router.refresh();
          });
        }}
      >
        {pending ? "Saving…" : "Make primary"}
      </Button>
      <ErrorNote message={error} />
    </>
  );
}

/**
 * Correct a contact's fields.
 *
 * Seeded from the contact as it stands, so a correction is an edit of what is
 * there rather than a re-entry of all four fields — clearing a field is then
 * something an operator does on purpose, not something they do by forgetting
 * to retype it.
 */
function EditContactForm({
  organisationId,
  contact,
  onDone,
}: {
  organisationId: string;
  contact: ContactRow;
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(contact.name ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [instagramHandle, setInstagramHandle] = useState(contact.instagramHandle ?? "");
  // #248. Starts on the sentinel, NOT on the contact's recorded basis: the
  // 259 migrated contacts hold `not_recorded_pre_migration`, which is
  // storable but never selectable, so there is no option that could seed and
  // round-trip it. "Keep as recorded" is the seed, and the field is omitted
  // from the submission entirely unless the operator picks something else.
  const [lawfulBasis, setLawfulBasis] = useState<string>(KEEP_RECORDED_BASIS);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The same floor the add form applies. Editing is the one path that can
  // reach "every identifying field cleared" from a valid row, which is why
  // the button is gated here as well as in the action.
  const hasField = [name, email, phone, instagramHandle].some((v) => v.trim().length > 0);

  const submit = () => {
    setError(null);
    const formData = new FormData();
    formData.set("name", name);
    formData.set("email", email);
    formData.set("phone", phone);
    formData.set("instagramHandle", instagramHandle);
    // Set only when it is a real correction. An absent field means "leave the
    // recorded basis alone" all the way down to `updateContact`'s COALESCE —
    // which is what keeps `sourced_at` and `source` honest too: a typo fix is
    // not a re-acquisition.
    if (lawfulBasis !== KEEP_RECORDED_BASIS) {
      formData.set("lawfulBasis", lawfulBasis);
    }
    startTransition(async () => {
      const result = await updateContactAction(organisationId, contact.id, formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone();
      router.refresh();
    });
  };

  return (
    <form
      // Named, so it is a landmark a screen reader can jump to and so the
      // four labels below do not collide with the add-contact form's
      // identical ones — an operator tabbing the page hears which contact
      // they are editing, not a second anonymous "Email".
      aria-label={`Edit ${displayContactName(contact.name)}`}
      className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <Label htmlFor={`edit-contact-name-${contact.id}`}>Name</Label>
        <Input
          id={`edit-contact-name-${contact.id}`}
          className="mt-1 h-9"
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`edit-contact-email-${contact.id}`}>Email</Label>
        <Input
          id={`edit-contact-email-${contact.id}`}
          className="mt-1 h-9"
          type="email"
          value={email}
          disabled={pending}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`edit-contact-phone-${contact.id}`}>Phone</Label>
        <Input
          id={`edit-contact-phone-${contact.id}`}
          className="mt-1 h-9"
          value={phone}
          disabled={pending}
          onChange={(event) => setPhone(event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`edit-contact-handle-${contact.id}`}>Instagram handle</Label>
        <Input
          id={`edit-contact-handle-${contact.id}`}
          className="mt-1 h-9"
          value={instagramHandle}
          disabled={pending}
          placeholder="@bondibaker"
          onChange={(event) => setInstagramHandle(event.target.value)}
        />
      </div>
      <div className="min-w-56">
        <Label htmlFor={`edit-contact-basis-${contact.id}`}>Lawful basis</Label>
        <div className="mt-1">
          <LawfulBasisSelect
            id={`edit-contact-basis-${contact.id}`}
            value={lawfulBasis}
            onValueChange={setLawfulBasis}
            disabled={pending}
            keepRecordedLabel={`Keep as recorded — ${lawfulBasisLabel(contact.lawfulBasis)}`}
          />
        </div>
        <LawfulBasisHint value={lawfulBasis} />
      </div>
      <Button type="submit" size="sm" disabled={pending || !hasField}>
        {pending ? "Saving…" : "Save contact"}
      </Button>
      <ErrorNote message={error} />
    </form>
  );
}

export function ContactsTab({
  organisationId,
  organisationName,
  contacts,
  canHardDelete,
}: {
  organisationId: string;
  organisationName: string;
  contacts: readonly ContactRow[];
  canHardDelete: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <AddContactForm organisationId={organisationId} />
      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No contacts recorded for this organisation.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {contacts.map((contact) => (
            <ContactRowItem
              key={contact.id}
              organisationId={organisationId}
              organisationName={organisationName}
              contact={contact}
              canHardDelete={canHardDelete}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
