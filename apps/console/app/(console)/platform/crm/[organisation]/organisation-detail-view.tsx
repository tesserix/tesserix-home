"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, CalloutDescription, Textarea } from "@tesserix/web";
import { CRM_STAGES, requiresProduct, type CrmStage } from "@/lib/crm";
import type {
  ActivityRow,
  ContactRow,
  OpportunityRow,
} from "@/lib/db/crm-repo";
import { addActivity, changeStage, scheduleNextAction } from "./actions";

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

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Callout role="alert" variant="destructive" className="mt-2">
      <CalloutDescription>{message}</CalloutDescription>
    </Callout>
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

function ActivityComposer({
  organisationId,
  opportunityId,
}: {
  organisationId: string;
  opportunityId?: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await addActivity({
            organisationId,
            opportunityId,
            kind: "note",
            body,
          });
          if (result.ok) {
            setBody("");
          } else {
            setError(result.message);
          }
          router.refresh();
        });
      }}
    >
      <label htmlFor="activity-note" className="text-sm font-medium">
        Add a note
      </label>
      <Textarea
        id="activity-note"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        placeholder="What happened?"
        disabled={pending}
      />
      <ErrorNote message={error} />
      <div>
        <Button type="submit" size="sm" disabled={pending || body.trim().length === 0}>
          {pending ? "Saving…" : "Add note"}
        </Button>
      </div>
    </form>
  );
}

export function ActivityTab({
  organisationId,
  activities,
}: {
  organisationId: string;
  activities: readonly ActivityRow[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <ActivityComposer organisationId={organisationId} />
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

export function OpportunitiesTab({
  organisationId,
  opportunities,
  products,
}: {
  organisationId: string;
  opportunities: readonly OpportunityRow[];
  products: readonly ProductOption[];
}) {
  if (opportunities.length === 0) {
    return <p className="text-sm text-muted-foreground">No opportunities for this organisation yet.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {opportunities.map((opportunity) => (
        <OpportunityCard
          key={opportunity.id}
          organisationId={organisationId}
          opportunity={opportunity}
          products={products}
        />
      ))}
    </div>
  );
}

export function ContactsTab({ contacts }: { contacts: readonly ContactRow[] }) {
  if (contacts.length === 0) {
    return <p className="text-sm text-muted-foreground">No contacts recorded for this organisation.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {contacts.map((contact) => (
        <li key={contact.id} className="border-t border-border pt-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{contact.name ?? "Unnamed contact"}</span>
            {contact.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-muted-foreground">
            {contact.email ? <span>{contact.email}</span> : null}
            {contact.phone ? <span>{contact.phone}</span> : null}
            {contact.instagramHandle ? <span>{contact.instagramHandle}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
