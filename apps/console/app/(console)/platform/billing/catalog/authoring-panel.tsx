// Load-bearing, same reason `catalog-views.tsx` and its three siblings carry
// one: this component holds interactive state (the fetched publish plan,
// the last publish outcome) and calls `useTransition` / `useEffect`, none of
// which a server component can do.
"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { Button } from "@tesserix/web";
import { SurfaceStateView } from "@/components/kit/states";
import { DestructiveConfirmDialog } from "@/components/kit/destructive-confirm-dialog";
import type { SurfaceState } from "@/components/kit/surface-state";
// Type-only across the server/client boundary, deliberately, for the exact
// reason `catalog-views.tsx`'s own header gives: `plan-catalog-repo.ts` and
// `stripe-read.ts` both carry `import "server-only"`, and a VALUE import of
// either would drag `pg` (and, for the latter, `stripe`) into this client
// bundle. `tsc` and `vitest` both pass; only `next build` catches it — see
// task 9's brief, which names this exact trap as the one this file is most
// likely on the whole branch to trip.
import type { CatalogRow } from "@/lib/db/plan-catalog-repo";
import type { PublishAttemptOutcome } from "@/lib/db/publish-repo";
import type { StripeMode } from "@/lib/billing/stripe-read";
import {
  discardDraftAction,
  planPublishAction,
  startDraftAction,
  type PublishActionResult,
  type PublishPlanSummary,
} from "./actions";
import { DraftEditor, type DraftEditorCell, type DraftEditorRow } from "./draft-editor";
import { PublishView } from "./publish-view";
// `PublishOutcome` and `OrphansCallout` are VALUE imports, safely:
// `publish-outcome.tsx` is itself a `"use client"` module and imports
// nothing `server-only`. Its two display shapes below are type-only for the
// usual reason — they are the trimmed forms that exist precisely so
// `PublishOperationRow` and `Orphan` never cross this boundary.
import {
  OrphansCallout,
  PublishOutcome,
  type PublishOutcomeOperation,
  type PublishOutcomeOrphan,
} from "./publish-outcome";

/**
 * Task 9's composition root — the one caller that mounts `DraftEditor`
 * (T3), `PublishView` (T4) and `PublishOutcome` (T5) together. Before this
 * task the only references to any of the three anywhere under
 * `apps/console/app` were their own files and their own tests: an
 * invocable write path with no caller. This file is the caller.
 *
 * # Why a separate file from `catalog-views.tsx`
 *
 * `catalog-views.tsx` is already past this codebase's 800-line file-size
 * guideline and answers a different question — "what is published, and is
 * the parity check happy" — a READ-ONLY concern with no server action of
 * its own. Everything in this file is the WRITE path: starting, editing and
 * discarding a draft, planning and confirming a publish, and showing what a
 * publish attempt did. Keeping the two apart means a change to one's
 * capability gating or write flow cannot silently reach into the other's
 * render.
 *
 * # Capability gating is PER CONTROL, not per page — task 9's brief, in one
 * sentence
 *
 * `page.tsx` carries no capability check of its own (see its header) and
 * this file does not add one either: what changes with `canDraft` and
 * `canPublish` is which CONTROLS are usable, never whether the section
 * renders. Every server action this file's controls call
 * (`startDraftAction`, `discardDraftAction`, `planPublishAction`,
 * `publishAction` inside `PublishView`) re-checks the identical capability
 * server-side — `withDraftWrite` / `withPublishWrite` in `actions.ts` — so
 * the checks here are for the operator's benefit (a stated reason, not a
 * vanished button), never the only line of defence.
 *
 * # Withheld means VISIBLE, with a reason — never hidden
 *
 * The same principle `publish-view.tsx`'s live refusal already follows
 * (shown, not hidden — see that file's header) applies here to both gates:
 * an operator holding `billing` but not `publish-catalog` sees the draft
 * editor working normally and a publish section that says, in words, why
 * publishing itself is withheld. A vanished control teaches an operator
 * nothing and reads as a bug; a stated reason does not.
 */

/**
 * Builds `DraftEditor`'s rows by joining the DRAFT's own catalog rows
 * (`readRevisionRows`, task 9's addition to `plan-catalog-repo.ts`) against
 * the currently PUBLISHED rows for the same mode — the comparison
 * `magnitudeWarning` (`draft-editor.tsx`) needs to warn an operator about an
 * implausible edit at the point of typing it.
 *
 * `plan`/`period`/`tier` come straight off the draft row — a draft always
 * carries its own copy of those columns (`createDraftFrom` copies the whole
 * price, not just its amounts), so there is nothing to infer from the
 * published side.
 *
 * `baselineCurrency`: left `null`, deliberately (review 2026-08-28,
 * controller ruling, promoted from Minor). `DraftEditorRow`'s own doc
 * comment names this "a Stripe fact (`existing.currency`), not a
 * convention this component is in a position to recompute" —
 * `readRevisionRows`' flat (price x currency) projection carries no
 * baseline flag, so THIS function is in exactly the position that comment
 * warns against. A plausible-but-wrong guess (the first currency this join
 * happened to see) is worse than an absent value: the first consumer to
 * read it would trust it. `draft-editor.tsx` does not read this field
 * today (grep confirms), so `null` costs nothing now and buys a type error
 * for whoever adds the first reader, instead of a silently wrong string.
 */
export function buildDraftEditorRows(
  draftRows: readonly CatalogRow[],
  publishedRows: readonly CatalogRow[],
): DraftEditorRow[] {
  const publishedByKey = new Map<string, Map<string, number>>();
  for (const row of publishedRows) {
    const byCurrency = publishedByKey.get(row.lookupKey) ?? new Map<string, number>();
    byCurrency.set(row.currency, row.unitAmountMinor);
    publishedByKey.set(row.lookupKey, byCurrency);
  }

  interface MutableRow {
    lookupKey: string;
    plan: string;
    period: string;
    tier: string;
    baselineCurrency: string | null;
    amounts: DraftEditorCell[];
  }

  const byKey = new Map<string, MutableRow>();
  const order: string[] = [];
  for (const row of draftRows) {
    let entry = byKey.get(row.lookupKey);
    if (!entry) {
      entry = {
        lookupKey: row.lookupKey,
        plan: row.plan,
        period: row.period,
        tier: row.tier,
        // See this function's own doc comment — `null`, not a guess.
        baselineCurrency: null,
        amounts: [],
      };
      byKey.set(row.lookupKey, entry);
      order.push(row.lookupKey);
    }
    const published = publishedByKey.get(row.lookupKey)?.get(row.currency) ?? null;
    entry.amounts.push({
      currency: row.currency,
      draftUnitAmountMinor: row.unitAmountMinor,
      publishedUnitAmountMinor: published,
      taxBehavior: row.taxBehavior,
    });
  }

  return order.map((key) => byKey.get(key)!);
}

/**
 * How many of the draft's rows differ from what is published — the number the
 * Draft tab's badge carries, so an operator on the Browse tab can see that a
 * draft is waiting without opening it.
 *
 * Derived from {@link buildDraftEditorRows} rather than from a second walk
 * over the two row sets, because that join is already the definition of
 * "changed" on this surface: it is what `DraftEditor` renders an "edited"
 * marker from, cell by cell (`draft-editor.tsx`'s own `dirty`). A separate
 * comparison here could disagree with the editor the badge is counting, and
 * the badge would be the one nobody checks.
 *
 * A row counts once however many of its currencies moved — the editor's rows
 * are per lookup key, and the tab is telling an operator how many prices to
 * look at, not how many cells.
 *
 * `publishedUnitAmountMinor` is `null` for a lookup key the published catalog
 * does not have, which counts as changed: an added price is a change to
 * publish. That is the same reading `DraftEditor` gives it.
 */
export function countChangedDraftRows(
  draftRows: readonly CatalogRow[],
  publishedRows: readonly CatalogRow[],
): number {
  return buildDraftEditorRows(draftRows, publishedRows).filter((row) =>
    row.amounts.some((cell) => cell.draftUnitAmountMinor !== cell.publishedUnitAmountMinor),
  ).length;
}

/**
 * A publish outcome as `page.tsx` reads it back out of
 * `plan_catalog_publish_attempts` — the durable half of what
 * `publishAction` returns in-session, and deliberately only that half.
 *
 * `outcome` is nullable here and not in `PublishActionResult` because the
 * log genuinely stores `PublishAttemptOutcome | null`: an attempt that
 * crashed between `startPublishAttempt` and `finishPublishAttempt` never
 * recorded a verdict. An action's return value can never be in that state;
 * a row read back can.
 *
 * No `orphans` field, on purpose. `findOrphans` is MODE-scoped, so an orphan
 * outlives the attempt that stranded it and belongs to the page, not to this
 * attempt — see {@link AuthoringPanelProps.orphans}.
 */
export interface PersistedPublishOutcome {
  readonly attemptId: string;
  readonly outcome: PublishAttemptOutcome | null;
  readonly promoted: boolean;
  readonly operations: readonly PublishOutcomeOperation[];
}

/** A read that FAILED, as opposed to one that succeeded and found nothing.
 *  `resolveState` resolves an ordinary absent row to `empty`, so `ready` and
 *  `empty` are both successes here — the same distinction `DraftSection`
 *  makes on `draftState`, extracted so the three reads this file now reacts
 *  to cannot each spell it differently. */
function readFailed(state: SurfaceState): boolean {
  return state.kind !== "ready" && state.kind !== "empty";
}

interface CapabilityNoticeProps {
  readonly children: ReactNode;
}

/** The shared shape for a withheld-but-visible control's reason — matching
 *  `publish-view.tsx`'s own `LIVE_REFUSAL_NOTE` styling rather than
 *  inventing a second one. */
function CapabilityNotice({ children }: CapabilityNoticeProps) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function StartDraftSection({ mode, canDraft }: { mode: StripeMode; canDraft: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canDraft) {
    return (
      <CapabilityNotice>
        Starting a draft needs the billing capability. Ask a platform operator who holds
        it to start one, or request the capability yourself.
      </CapabilityNotice>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        No draft is open. Starting one copies {mode}&apos;s currently published catalog into a
        working copy nothing else can see until it is published.
      </p>
      <div>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await startDraftAction(mode);
              if (!result.ok) setError(result.message);
            })
          }
        >
          Start a draft
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function DiscardDraftButton({ revisionId }: { revisionId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Discard draft
      </Button>
      <DestructiveConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Discard this draft?"
        description="Every edit in this draft is deleted. Stripe is untouched — nothing here was ever published."
        confirmLabel="Discard draft"
        confirmId="discard-draft-confirm-button"
        loading={pending}
        onConfirm={() =>
          startTransition(async () => {
            setError(null);
            const result = await discardDraftAction(revisionId);
            if (result.ok) {
              setOpen(false);
            } else {
              setError(result.message);
            }
          })
        }
      >
        {error ? <p role="alert">{error}</p> : null}
      </DestructiveConfirmDialog>
    </>
  );
}

/**
 * The publish half: fetches the plan (`planPublishAction` — a read, safe to
 * call for any operator holding `billing`, see that action's own doc
 * comment) only when `canPublish` is true, so an operator who will never see
 * the result never triggers the Stripe read behind it.
 *
 * `live` still needs no special case here, but for a different reason than
 * it used to (#327 P2b): `checkGuards`' `mode` rule now returns a
 * CONFIRMATION for `mode === "live"` rather than a refusal
 * (`publish-guards.ts`), so `PublishView` receives a `verdict` carrying that
 * breach and renders `LIVE_CONFIRMATION_NOTE` in front of its typed-mode
 * gate. Mounting this section for `live` still cannot reach a live publish
 * by itself — it can only show what one would do and ask the operator to
 * name the mode.
 *
 * The one thing that DID change: this section's `planPublishAction` call
 * now reads Stripe for `live` too, where the mode refusal used to
 * short-circuit it (`actions.ts`'s `observeAndPlan`). That read is the plan
 * the operator is being asked to confirm; there is nothing to confirm
 * without it.
 */
function PublishSection({
  revisionId,
  mode,
  canPublish,
  onOutcome,
}: {
  revisionId: string;
  mode: StripeMode;
  canPublish: boolean;
  onOutcome: (result: Extract<PublishActionResult, { readonly ok: true }>) => void;
}) {
  const [plan, setPlan] = useState<PublishPlanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(canPublish);

  useEffect(() => {
    if (!canPublish) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    planPublishAction(revisionId, mode).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setPlan(result.plan);
      } else {
        setError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [revisionId, mode, canPublish]);

  if (!canPublish) {
    return (
      <CapabilityNotice>
        Publishing is withheld here: it needs the publish-catalog capability in addition
        to billing. You can keep drafting — an operator who holds publish-catalog can
        review and publish this draft once it is ready.
      </CapabilityNotice>
    );
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Building the publish plan…</p>;
  }

  if (error || !plan) {
    return <p role="alert">{error ?? "The publish plan could not be built."}</p>;
  }

  return (
    <PublishView
      revisionId={plan.revisionId}
      mode={plan.mode}
      counts={plan.counts}
      unactionable={plan.unactionable}
      verdict={plan.verdict}
      onPublished={onOutcome}
    />
  );
}

export interface AuthoringPanelProps {
  readonly mode: StripeMode;
  /** The mode's currently published rows — already read by `page.tsx` for
   *  the read-only catalog table; reused here rather than read twice. */
  readonly catalog: readonly CatalogRow[];
  /** Whether the PUBLISHED catalog read (`page.tsx`'s `catalogResult`)
   *  succeeded. Review 2026-08-28 (Important, controller ruling): when it
   *  fails, `catalog` falls back to `[]`, which used to reach
   *  `buildDraftEditorRows` looking identical to "this mode genuinely has no
   *  published prices yet" — every `publishedUnitAmountMinor` came back
   *  `null`, which silently switches off `draft-editor.tsx`'s
   *  implausible-edit warning with nothing on screen saying why. This prop
   *  is what lets the editor say so, in words, instead of quietly running
   *  with its guard disabled. */
  readonly catalogState: SurfaceState;
  /** Whether `page.tsx`'s "does a draft exist" read succeeded — narrowed
   *  independently of every other read on that page (see its own module doc
   *  comment). A failure here shows a message for THIS section alone; the
   *  read-only catalog above is unaffected because it never depended on
   *  this read succeeding. */
  readonly draftState: SurfaceState;
  readonly draftId: string | null;
  /** `null` when there is no draft, OR when the rows read failed — the two
   *  are distinguished by `draftRowsState.kind`, never conflated. */
  readonly draftRows: readonly CatalogRow[] | null;
  readonly draftRowsState: SurfaceState;
  readonly canDraft: boolean;
  readonly canPublish: boolean;
  /** Path the "Re-plan" control inside a mounted `PublishOutcome` returns
   *  the operator to — this surface, with `mode` preserved. */
  readonly replanHref: string;
  /** The mode's latest UNRESOLVED publish attempt, read back from the log by
   *  `page.tsx` (tesserix-home#410). It exists because the session outcome
   *  below survives exactly one page load: before this prop, an operator who
   *  published, closed the tab and came back found a page that looked as
   *  though nothing had ever happened. `page.tsx` has already applied
   *  Decision 1 (`surfacedAttempt`) — a `succeeded` latest attempt arrives
   *  here as `null`, because success is durably surfaced by the publication
   *  block instead. Optional so the many callers that mount this panel
   *  without a persisted read (every test above #410's) stay valid. */
  readonly persistedOutcome?: PersistedPublishOutcome | null;
  /** Whether the attempt read itself succeeded — narrowed independently of
   *  every other read on the page. Distinguishes "no unresolved attempt"
   *  (nothing to say) from "we could not find out", which are opposite
   *  facts an operator must never see conflated. */
  readonly attemptState?: SurfaceState;
  /** Whether the attempt's operation log could be read. Separate from
   *  `attemptState` because an operator who can see THAT a publish failed
   *  but not WHAT it did is in a different position from one who can see
   *  neither, and the copy has to say which. */
  readonly operationsState?: SurfaceState;
  /** Prices this catalog's log believes it archived that Stripe still
   *  reports active. A PAGE-level fact, not an attempt-level one:
   *  `findOrphans` is mode-scoped, so an orphan outlives the attempt that
   *  stranded it and survives a later successful publish. That is why these
   *  are rendered on the union with `persistedOutcome` rather than nested
   *  inside it — an orphan with no unresolved attempt still gets a surface,
   *  and nothing else in the estate can see one (the nightly parity check
   *  structurally cannot; see `publish-outcome.tsx`'s header). */
  readonly orphans?: readonly PublishOutcomeOrphan[];
  /** Whether the orphan check ran. The only read behind this panel that
   *  leaves the estate (`findOrphans` reaches Stripe), and the one whose
   *  failure most needs saying out loud: silently rendering no orphans on a
   *  Stripe outage would read exactly like a clean check. */
  readonly orphansState?: SurfaceState;
}

/**
 * The draft section's own body — everything ABOVE the publish-outcome
 * section. Split out of {@link AuthoringPanel} so that component's `return`
 * can render this conditionally while the outcome section below it never
 * is — see that component's own comment on why the split matters.
 */
function DraftSection({
  mode,
  catalog,
  catalogState,
  draftState,
  draftId,
  draftRows,
  draftRowsState,
  canDraft,
  canPublish,
  onOutcome,
}: {
  mode: StripeMode;
  catalog: readonly CatalogRow[];
  catalogState: SurfaceState;
  draftState: SurfaceState;
  draftId: string | null;
  draftRows: readonly CatalogRow[] | null;
  draftRowsState: SurfaceState;
  canDraft: boolean;
  canPublish: boolean;
  onOutcome: (result: Extract<PublishActionResult, { readonly ok: true }>) => void;
}) {
  // `resolveState` resolves "no draft exists" (an ordinary, common outcome —
  // `readDraft` succeeded and simply found nothing) to `empty`, not `ready`
  // — see `surface-state.ts`. `ready` and `empty` are therefore BOTH
  // successful reads here; only `error` / `instrumentation-unavailable` /
  // `reauth-required` mean the read itself failed and this section has
  // nothing trustworthy to act on.
  if (draftState.kind !== "ready" && draftState.kind !== "empty") {
    return (
      <section className="flex flex-col gap-3" aria-label="Draft">
        <h2 className="text-sm font-medium">Draft</h2>
        <SurfaceStateView state={draftState} emptyMessage="No draft is open." />
      </section>
    );
  }

  if (draftId === null) {
    return (
      <section className="flex flex-col gap-3" aria-label="Draft">
        <h2 className="text-sm font-medium">Draft</h2>
        <StartDraftSection mode={mode} canDraft={canDraft} />
      </section>
    );
  }

  // The published catalog is the ONLY source `buildDraftEditorRows` has for
  // `publishedUnitAmountMinor`, which `magnitudeWarning` (`draft-editor.tsx`)
  // needs to warn about an implausible edit. A failed catalog read must not
  // silently disable that guard — see `catalogState`'s own doc comment on
  // `AuthoringPanelProps`.
  const catalogUnavailable = catalogState.kind !== "ready" && catalogState.kind !== "empty";

  return (
    <>
      <section className="flex flex-col gap-3" aria-label="Draft">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Draft</h2>
          {canDraft ? <DiscardDraftButton revisionId={draftId} /> : null}
        </div>
        {draftRowsState.kind === "ready" && draftRows ? (
          canDraft ? (
            <>
              {catalogUnavailable ? (
                <p role="status" className="text-sm text-muted-foreground">
                  The published catalog could not be read, so the implausible-edit warning
                  below is unavailable for this render — every amount will look unchanged
                  from what is published. Publishing still re-checks this guard
                  server-side before anything reaches Stripe.
                </p>
              ) : null}
              <DraftEditor
                revisionId={draftId}
                rows={buildDraftEditorRows(draftRows, catalogUnavailable ? [] : catalog)}
              />
            </>
          ) : (
            <CapabilityNotice>
              A draft is open, but editing it needs the billing capability.
            </CapabilityNotice>
          )
        ) : (
          <SurfaceStateView
            state={draftRowsState}
            emptyMessage="This draft has no priced rows yet."
          />
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Publish">
        <h2 className="text-sm font-medium">Publish</h2>
        <PublishSection
          revisionId={draftId}
          mode={mode}
          canPublish={canPublish}
          onOutcome={onOutcome}
        />
      </section>
    </>
  );
}

export function AuthoringPanel({
  mode,
  catalog,
  catalogState,
  draftState,
  draftId,
  draftRows,
  draftRowsState,
  canDraft,
  canPublish,
  replanHref,
  persistedOutcome = null,
  attemptState = { kind: "empty" },
  operationsState = { kind: "empty" },
  orphans = [],
  orphansState = { kind: "empty" },
}: AuthoringPanelProps) {
  const [outcome, setOutcome] = useState<Extract<PublishActionResult, { readonly ok: true }> | null>(
    null,
  );

  // Decision 3 (tesserix-home#410): the SESSION outcome wins, and the
  // persisted read is a fallback rather than a replacement. An operator who
  // has just published performed the action and deserves the receipt for it
  // — including a success, which `page.tsx` deliberately never reads back
  // (`surfacedAttempt`). On a RELOAD that success does not return, because
  // by then `readLivePublication` -> `CatalogViews`'s publication block is
  // the honest surface for it: a persisted success banner would be a second
  // account of one event, and the worse of the two, since "Stripe now
  // matches this revision" is a claim about Stripe's CURRENT state that
  // decays silently as the catalog drifts. A FAILURE shows both ways, from
  // two sources that agree.
  const shown: PersistedPublishOutcome | null = outcome ?? persistedOutcome;

  // Which observation of the mode-scoped orphan check to trust. Both are the
  // same `findOrphans(mode)` call, so when the session ran one it is simply
  // the later of the two and supersedes the page's load-time list. But
  // `actions.ts` only runs it on a FAILED outcome, so on any other session
  // outcome there is no session observation at all — falling back to the
  // page's list there is what stops a successful publish from hiding a
  // pre-existing orphan it never looked for.
  const shownOrphans: readonly PublishOutcomeOrphan[] =
    outcome && outcome.outcome === "failed" ? outcome.orphans : orphans;

  // The UNION, per Decision 2: an orphan outlives the attempt that stranded
  // it, so a page with orphans and no unresolved attempt still mounts this
  // section. So does a page where one of the two reads FAILED — silently
  // rendering nothing on a Stripe outage would look exactly like a clean
  // check, which is the failure this surface exists to make visible.
  const showOutcomeSection =
    shown !== null ||
    shownOrphans.length > 0 ||
    readFailed(attemptState) ||
    readFailed(orphansState);

  // CRITICAL fix, review 2026-08-28 (controller ruling): the outcome section
  // is rendered HERE, unconditionally, never inside `DraftSection`'s
  // draft-dependent branches. A SUCCESSFUL publish calls `promotePublication`
  // (`actions.ts`), which moves the revision out of `UNPUBLISHED_REVISION`
  // (`publish-repo.ts`) — so by the time `publishAction`'s own
  // `revalidatePath` lands, `currentDraft()` correctly returns `null` and
  // `draftId` becomes `null` too, in the SAME transition `onPublished` fires
  // in. `DraftSection` would then take its "no draft is open" branch and
  // never reach an outcome block nested inside it — exactly the bug this
  // hoist fixes. A FAILED publish never promotes, so the draft (and
  // `DraftSection`'s draft-editing branch) survives either way, which is why
  // this was invisible in every failed-publish test written before this fix.
  return (
    <div className="flex flex-col gap-8">
      <DraftSection
        mode={mode}
        catalog={catalog}
        catalogState={catalogState}
        draftState={draftState}
        draftId={draftId}
        draftRows={draftRows}
        draftRowsState={draftRowsState}
        canDraft={canDraft}
        canPublish={canPublish}
        onOutcome={setOutcome}
      />

      {showOutcomeSection ? (
        <section className="flex flex-col gap-3" aria-label="Publish outcome">
          <h2 className="text-sm font-medium">Latest publish attempt</h2>
          {readFailed(attemptState) ? (
            <SurfaceStateView state={attemptState} emptyMessage="No publish attempt to report." />
          ) : null}
          {readFailed(orphansState) ? (
            <SurfaceStateView
              state={orphansState}
              emptyMessage="No orphaned Stripe prices."
            />
          ) : null}
          {shown ? (
            <>
              {/* Only for a PERSISTED outcome: a session outcome carries its
                  own operations back from the action and never went through
                  the dependent `readOperations` read that this state
                  narrows. */}
              {outcome === null && readFailed(operationsState) ? (
                <SurfaceStateView
                  state={operationsState}
                  emptyMessage="This attempt recorded no operations."
                />
              ) : null}
              <PublishOutcome
                attemptId={shown.attemptId}
                mode={mode}
                outcome={shown.outcome}
                promoted={shown.promoted}
                // `null`, not `[]`, when the dependent operations read
                // failed: page.tsx has nothing to pass, and an empty array
                // there is a CLAIM — "this attempt did nothing" — that the
                // status line then counts (`0 operation(s) failed`) and the
                // table then restates ("No operations were recorded for this
                // attempt"), both under the callout above saying the read
                // failed. Same predicate the callout itself is gated on, so
                // the two can never disagree.
                operations={
                  outcome === null && readFailed(operationsState) ? null : shown.operations
                }
                orphans={shownOrphans}
                replanHref={replanHref}
              />
            </>
          ) : (
            // No attempt to hang them off — `PublishOutcome` is an attempt's
            // surface and has nothing to say without one, so its orphan
            // callout is mounted directly rather than faking an attempt
            // around it.
            <OrphansCallout orphans={shownOrphans} />
          )}
        </section>
      ) : null}
    </div>
  );
}
