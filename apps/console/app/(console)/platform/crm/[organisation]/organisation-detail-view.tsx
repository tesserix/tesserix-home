"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  CalloutDescription,
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
import type {
  ActivityRow,
  ContactRow,
  OpportunityRow,
} from "@/lib/db/crm-repo";
import { NO_PRODUCT_VALUE } from "@/lib/db/crm-filters";
import { ActivityComposer } from "./activity-composer";
import { ErrorNote } from "./error-note";
import {
  addContactAction,
  changeStage,
  createOpportunityAction,
  deleteOrganisationAction,
  eraseContactAction,
  scheduleNextAction,
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
      router.refresh();
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
        description={`This overwrites ${contactLabel}'s name, email, phone, and Instagram handle. ${organisationName}'s deal history — its opportunities and activity log — is kept exactly as it is. This cannot be undone.`}
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
    </>
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
}: {
  organisationId: string;
  opportunity: OpportunityRow;
  products: readonly ProductOption[];
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
            {opportunity.product
              ? products.find((p) => p.context === opportunity.product)?.name ?? opportunity.product
              : "No product yet"}
          </span>
          {opportunity.owner ? (
            <span className="text-sm text-muted-foreground">· {opportunity.owner}</span>
          ) : null}
        </div>
      </div>

      {isGrandfathered ? (
        <Callout variant="destructive" className="mt-3">
          <CalloutDescription>
            This opportunity was migrated from the old CRM without a product. It cannot be
            edited — including scheduling a next action — until a product is assigned below.
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
  opportunities,
}: {
  organisationId: string;
  activities: readonly ActivityRow[];
  /** Passed only so the composer can offer a follow-up against a real deal
   *  once contact is logged (#245) — the timeline itself does not use them. */
  opportunities: readonly OpportunityRow[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <ActivityComposer organisationId={organisationId} opportunities={opportunities} />
      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      ) : (
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
}: {
  organisationId: string;
  opportunities: readonly OpportunityRow[];
  products: readonly ProductOption[];
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
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setName("");
      setEmail("");
      setPhone("");
      setInstagramHandle("");
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
      <Button type="submit" size="sm" disabled={pending || !hasField}>
        {pending ? "Adding…" : "Add contact"}
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
            <li key={contact.id} className="border-t border-border pt-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{displayContactName(contact.name)}</span>
                  {contact.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
                </div>
                {canHardDelete ? (
                  <EraseContactButton organisationName={organisationName} contact={contact} />
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-muted-foreground">
                {contact.email ? <span>{contact.email}</span> : null}
                {contact.phone ? <span>{contact.phone}</span> : null}
                {contact.instagramHandle ? <span>{contact.instagramHandle}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
