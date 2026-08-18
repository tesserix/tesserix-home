"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@tesserix/web";
import {
  HUMAN_ACTIVITY_KINDS,
  isContactActivityKind,
  isOpenStage,
  requiresProduct,
  type HumanActivityKind,
} from "@/lib/crm";
import type { OpportunityRow } from "@/lib/db/crm-repo";
import { addActivity, scheduleNextAction } from "./actions";
import { ErrorNote } from "./error-note";

/**
 * Record what happened with this business (#245).
 *
 * Its own file, not a function inside `organisation-detail-view.tsx`: that
 * file is already near this repo's size ceiling, and this composer now owns
 * two related but separable jobs — logging the contact, then offering a
 * follow-up — rather than the one textarea it used to be.
 *
 * Deliberately organisation-level, naming no deal. An operator who has just
 * had a call has had it with the BUSINESS; asking them to attribute it to a
 * deal before it can be recorded is a question they often cannot answer, and
 * the write path treats an unattributed contact event as touching every deal
 * still in play (`advanceContactClock`, crm-repo.ts). Per-deal logging stays
 * where per-deal work already is, on the Opportunities tab.
 */

const KIND_LABELS: Record<HumanActivityKind, string> = {
  note: "Note",
  call: "Call",
  dm_sent: "DM sent",
  dm_received: "DM received",
  email_sent: "Email sent",
  email_received: "Email received",
};

/**
 * How far ahead the follow-up prompt points by default. Comfortably inside
 * `DRIFT_DAYS` (14): the whole point of the prompt is that a contacted lead
 * with nothing scheduled drifts back into the queue, so a default that
 * landed on or past the threshold would schedule the drift rather than
 * prevent it. A starting point, not a rule — the field is editable.
 */
const FOLLOW_UP_DAYS = 3;
const FOLLOW_UP_HOUR = 9;

/** `datetime-local` wants local wall-clock time, `YYYY-MM-DDTHH:mm` — not an
 *  ISO instant, which would silently shift the value by the UTC offset. */
function defaultFollowUpAt(now: Date = new Date()): string {
  const at = new Date(now);
  at.setDate(at.getDate() + FOLLOW_UP_DAYS);
  at.setHours(FOLLOW_UP_HOUR, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The deals a follow-up can actually be scheduled against: open, and not
 * grandfathered. `setNextAction` refuses a migrated row with no product
 * (migration 0021's CHECK) — offering one here would be offering a control
 * that cannot succeed, so the prompt stays silent instead. Those deals are
 * fixed on the Opportunities tab, which says so.
 */
function schedulable(opportunities: readonly OpportunityRow[]): readonly OpportunityRow[] {
  return opportunities.filter(
    (o) => isOpenStage(o.stage) && (!requiresProduct(o.stage) || o.product !== null),
  );
}

function dealLabel(opportunity: OpportunityRow): string {
  return opportunity.product ?? "No product yet";
}

export function ActivityComposer({
  organisationId,
  opportunities,
}: {
  organisationId: string;
  opportunities: readonly OpportunityRow[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<HumanActivityKind>("note");
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [followUpFor, setFollowUpFor] = useState<HumanActivityKind | null>(null);

  const targets = schedulable(opportunities);
  // A note is only ever its words, so an empty one records nothing. A call
  // or a DM is itself the fact being recorded, and demanding a sentence
  // about it is exactly the friction that left the drift clock unwritten.
  const canSubmit = isContactActivityKind(kind) || body.trim().length > 0;

  const submit = () => {
    setError(null);
    setFollowUpFor(null);
    startTransition(async () => {
      const result = await addActivity({
        organisationId,
        kind,
        body: body.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setBody("");
      if (isContactActivityKind(kind) && targets.length > 0) setFollowUpFor(kind);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="activity-kind">Activity</Label>
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as HumanActivityKind)}
              disabled={pending}
            >
              <SelectTrigger id="activity-kind" size="sm" className="mt-1 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HUMAN_ACTIVITY_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {KIND_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Label htmlFor="activity-body">What happened?</Label>
        <Textarea
          id="activity-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          placeholder={kind === "note" ? "What is worth remembering?" : "Optional detail"}
          disabled={pending}
        />
        <ErrorNote message={error} />
        <div>
          <Button type="submit" size="sm" disabled={pending || !canSubmit}>
            {pending ? "Saving…" : "Log activity"}
          </Button>
        </div>
      </form>

      {followUpFor ? (
        <FollowUpPrompt
          organisationId={organisationId}
          kindLabel={KIND_LABELS[followUpFor]}
          targets={targets}
          onDone={() => setFollowUpFor(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Offered after contact, never forced (#245, decision 2).
 *
 * Contact and scheduling are separate writes, and only the second one takes
 * an organisation out of the drifting queue for longer than the 14-day
 * window. Prompting here is what stops a diligently logged call from
 * drifting back in a fortnight later — but an operator who has nothing to
 * schedule can decline, and the contact they just logged is already saved
 * either way. This never blocks, and dismissing it loses nothing.
 */
function FollowUpPrompt({
  organisationId,
  kindLabel,
  targets,
  onDone,
}: {
  organisationId: string;
  kindLabel: string;
  targets: readonly OpportunityRow[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [opportunityId, setOpportunityId] = useState(targets[0].id);
  const [at, setAt] = useState(() => defaultFollowUpAt());
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await scheduleNextAction({
        organisationId,
        opportunityId,
        at: at ? new Date(at).toISOString() : null,
        note: note.trim() || null,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone();
      router.refresh();
    });
  };

  // `aria-live`: announced, not focused. This region appears in response to
  // something the operator just did, so a screen reader that says nothing
  // leaves them unaware the offer exists — while moving focus into it would
  // interrupt someone who is done and moving on. The prompt is optional; its
  // announcement should be too.
  return (
    <section
      role="group"
      aria-labelledby="follow-up-heading"
      aria-live="polite"
      className="rounded-md border border-border p-4"
    >
      <h3 id="follow-up-heading" className="text-sm font-medium">
        Schedule a follow-up?
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {kindLabel} logged. Anything with no next action drifts back into the queue.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        {targets.length > 1 ? (
          <div>
            <Label htmlFor="follow-up-deal">Deal</Label>
            <Select value={opportunityId} onValueChange={setOpportunityId} disabled={pending}>
              <SelectTrigger id="follow-up-deal" size="sm" className="mt-1 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {dealLabel(target)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div>
          <Label htmlFor="follow-up-at">When</Label>
          <input
            id="follow-up-at"
            type="datetime-local"
            className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={at}
            disabled={pending}
            onChange={(event) => setAt(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="follow-up-note">Note</Label>
          <input
            id="follow-up-note"
            className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <Button type="button" size="sm" disabled={pending || at === ""} onClick={submit}>
          {pending ? "Saving…" : "Schedule"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onDone}>
          Not now
        </Button>
      </div>

      <ErrorNote message={error} />
    </section>
  );
}
