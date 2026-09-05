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
  defaultNextActionAt,
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

/** `datetime-local` wants local wall-clock time, `YYYY-MM-DDTHH:mm` — not an
 *  ISO instant, which would silently shift the value by the UTC offset. */
function toLocalInputValue(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The deals a follow-up can actually be scheduled against: open, and not
 * grandfathered. `setNextAction` refuses a migrated row with no product
 * (migration 0021's CHECK) — offering one here would be offering a control
 * that cannot succeed, so the prompt stays silent instead. Those deals are
 * fixed on the Opportunities tab, which says so.
 *
 * This predicate is `CLOCK_ELIGIBLE_SQL` (crm-repo.ts) in TypeScript, and the
 * two have to keep agreeing: it is now also the set of deals the log itself
 * scheduled a follow-up for. If this were the wider of the two, the prompt
 * would offer to adjust a date that was never written; if it were the
 * narrower, a date would be written with no way to clear it.
 */
function schedulable(opportunities: readonly OpportunityRow[]): readonly OpportunityRow[] {
  return opportunities.filter(
    (o) =>
      isOpenStage(o.stage) &&
      (!requiresProduct(o.stage) || o.product !== null) &&
      // The third conjunct of `CLOCK_ELIGIBLE_SQL` (#251). A voided deal is
      // still listed on this page, so without this it would be offered here
      // — and `setNextAction` refuses it by name, which is the "control that
      // cannot succeed" this predicate exists to avoid offering.
      o.voidedAt === null,
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
          kind={followUpFor}
          targets={targets}
          onDone={() => setFollowUpFor(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * WHAT THIS IS NOW, AND WHY IT CHANGED (#502).
 *
 * It used to be the only thing that ever wrote `next_action_at`: contact and
 * scheduling were two separate writes, and an operator who dismissed this
 * prompt left the lead with a null next action — which is not "unscheduled",
 * it is the literal definition of Drifting. Logging a DM therefore filed the
 * lead as drifting unless the operator remembered a second step, every time.
 *
 * `logActivity` now sets the date itself, in the same transaction as the
 * activity. So this is no longer an OFFER to schedule; it is the operator's
 * chance to CHANGE OR CLEAR what was just scheduled, which is the other half
 * of the issue's requirement — "a default, not a rule ... some replies deserve
 * tomorrow and some leads deserve never". Without a clear control the default
 * would be exactly the rule that requirement forbids.
 *
 * It still never blocks. Dismissing it now KEEPS the default rather than
 * losing the schedule, which is the safe direction: the failure this fixes was
 * leads with no date, not leads with one.
 */
function FollowUpPrompt({
  organisationId,
  kind,
  targets,
  onDone,
}: {
  organisationId: string;
  kind: HumanActivityKind;
  targets: readonly OpportunityRow[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [opportunityId, setOpportunityId] = useState(targets[0].id);
  // Prefilled with what the write path just wrote — `defaultNextActionAt` is
  // the shared rule its SQL twin (`nextActionAssignment`, crm-repo.ts) states
  // in a CASE expression. Showing a different date from the one in the
  // database would describe a schedule nobody has.
  const [at, setAt] = useState(() => toLocalInputValue(defaultNextActionAt(kind)));
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
  // leaves them unaware a date was set — while moving focus into it would
  // interrupt someone who is done and moving on. Acting on the prompt is
  // optional; its announcement should be too.
  return (
    <section
      role="group"
      aria-labelledby="follow-up-heading"
      aria-live="polite"
      className="rounded-md border border-border p-4"
    >
      <h3 id="follow-up-heading" className="text-sm font-medium">
        Follow-up scheduled
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {KIND_LABELS[kind]} logged, and a follow-up set. Change the date, or clear it if this
        lead needs none.
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
        {/* NOT disabled on an empty date, which is the change #502 needed here.
            An empty field submits `at: null`, and null is what "this lead
            needs no follow-up" is spelled as. While the prompt was the only
            writer of the column, disabling it was harmless — the date was
            already null and there was nothing to undo. Now that the log
            writes a default, a control the operator cannot use to remove it
            makes the default a rule. */}
        <Button type="button" size="sm" disabled={pending} onClick={submit}>
          {pending ? "Saving…" : at === "" ? "Clear follow-up" : "Schedule"}
        </Button>
        {/* Dismissal KEEPS the scheduled default rather than discarding it, so
            the wording is "done", not "not now" — there is no longer an offer
            being declined. */}
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onDone}>
          Leave it
        </Button>
      </div>

      <ErrorNote message={error} />
    </section>
  );
}
