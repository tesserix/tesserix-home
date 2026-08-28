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
import { PublishOutcome } from "./publish-outcome";

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
 * `live` needs no special case here: `checkGuards`' own `checkMode` rule
 * refuses `mode === "live"` inside the plan this fetches (`publish-guards.ts`),
 * so `PublishView` receives a `verdict` that already carries the refusal and
 * renders `LIVE_REFUSAL_NOTE` itself — mounting this section for `live`
 * cannot create a path that reaches a live publish; it can only show why
 * one is refused.
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
}: AuthoringPanelProps) {
  const [outcome, setOutcome] = useState<Extract<PublishActionResult, { readonly ok: true }> | null>(
    null,
  );

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

      {outcome ? (
        <section className="flex flex-col gap-3" aria-label="Publish outcome">
          <h2 className="text-sm font-medium">Latest publish attempt</h2>
          <PublishOutcome
            attemptId={outcome.attemptId}
            mode={mode}
            outcome={outcome.outcome}
            promoted={outcome.promoted}
            operations={outcome.operations}
            orphans={outcome.orphans}
            replanHref={replanHref}
          />
        </section>
      ) : null}
    </div>
  );
}
