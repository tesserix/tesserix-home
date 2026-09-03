// `SurfaceTabs` and `ModeToggle` both reach `@tesserix/web` (directly or
// through the tree below them), whose barrel is "use client" — its exports are
// `undefined` in a server component, which is what PR #539 shipped. This
// directive is load-bearing, and `lib/server-component-web-import.guard.test.ts`
// is what holds the line.
"use client";

import { useMemo } from "react";
import { SurfaceTabs } from "@/components/kit/surface-tabs";
import { ModeToggle } from "./catalog-views";
import { countChangedDraftRows } from "./authoring-panel";
// Type-only, the same discipline every client module on this surface keeps:
// `plan-catalog-repo.ts` carries `import "server-only"`, so a VALUE import
// would drag `pg` into this bundle. The rows arrive as plain props.
import type { CatalogRow } from "@/lib/db/plan-catalog-repo";
import type { StripeMode } from "@/lib/billing/stripe-read";
import type { ReactNode } from "react";

/**
 * The plan catalog page's shell: what is true of the WHOLE page above the tab
 * bar, and the tabs themselves below it.
 *
 * # Why a shell at all
 *
 * The page rendered as one column — observation window, then the published
 * catalog, then the authoring panel — so every operator arriving to do one of
 * those three things scrolled past the other two. Browse and Draft & Publish
 * are the two jobs; the strip and the mode are neither, and sit above.
 *
 * # Why N tabs and not a hardcoded pair
 *
 * `tesserix-home#521` added promo codes under `/platform/billing`, and that is
 * what this arrangement was built for. What it actually cost, recorded here
 * rather than left as a promise: one entry in the array below, one `ReactNode`
 * prop to carry the panel, and the corresponding construction in `page.tsx`.
 * No new tab implementation and no change to `SurfaceTabs`.
 *
 * The one correction to this paragraph's earlier wording — which claimed "no
 * change to this component's props" — is that a THIRD panel does need a third
 * prop, because the panels arrive as nodes (see below). "One array entry plus
 * one prop" is the honest price; the array is what stays open-ended.
 *
 * # Why the panels arrive as nodes
 *
 * `page.tsx` is a SERVER component and does the reading; it constructs
 * `CatalogViews` and `AuthoringPanel` with what it read and hands the finished
 * elements down. That keeps this file from having to re-declare the two
 * panels' twenty-odd props just to forward them, and keeps `page.tsx` free of
 * any call into a `"use client"` module (see `draftRows` below for the one
 * place that distinction bites).
 */

/* ------------------------------------------------------------------------ *
 * The Draft tab's badges
 * ------------------------------------------------------------------------ */

/** A changed-row count, styled as a quiet neutral pill. The count is IN the
 *  visible text rather than announced separately, so the trigger reads as
 *  "Draft & Publish 3 changed" to a screen reader and to everyone else. */
function ChangedBadge({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums">
      {`${count} changed`}
    </span>
  );
}

/**
 * The marker for a last publish attempt that did not succeed.
 *
 * Distinct from `ChangedBadge` in WORDS, not only in colour: an outlined
 * destructive pill reading "Needs attention" beside a filled neutral one
 * reading "3 changed". Colour alone would say nothing to an operator who
 * cannot distinguish it, and nothing at all to a screen reader.
 *
 * It exists because the tabs hid something. The failed-attempt alert lives
 * inside `AuthoringPanel`; before this marker an operator could sit on Browse
 * indefinitely and never learn that a live publish had failed.
 */
function AttentionBadge() {
  return (
    <span className="rounded-full border border-destructive px-2 py-0.5 text-xs font-medium text-destructive">
      Needs attention
    </span>
  );
}

/* ------------------------------------------------------------------------ *
 * The shell
 * ------------------------------------------------------------------------ */

export interface CatalogSurfaceProps {
  readonly mode: StripeMode;
  /** The observation strip, built by `page.tsx` from its own window and runs
   *  reads. Above the tabs because the parity check's verdict is a fact about
   *  the whole page — both tabs are about the catalog it watches. */
  readonly observation: ReactNode;
  readonly browse: ReactNode;
  readonly authoring: ReactNode;
  /**
   * The promo-code surface (#521, T4) — the third tab, and the first test of
   * the claim above.
   *
   * It cost exactly what that paragraph promised of THIS file: one prop and
   * one array entry. The reason it is a prop at all is the same reason
   * `browse` and `authoring` are — `page.tsx` does the reading and hands the
   * finished element down, so this component never learns the panel's props
   * and never imports a module that reaches `pg`.
   */
  readonly promoCodes: ReactNode;
  /**
   * The draft's rows and the published rows, for the Draft tab's changed
   * count and nothing else — both are already inside `authoring`.
   *
   * Passed as DATA rather than as a number `page.tsx` computed, because
   * `page.tsx` cannot compute it: `countChangedDraftRows` is exported from
   * `authoring-panel.tsx`, a `"use client"` module, and every export of one is
   * a client reference in a server component — calling it there throws at
   * runtime while `tsc`, `next build` and jsdom tests all pass. `page.tsx`'s
   * own header records the identical trap for `resolveState`.
   *
   * `null` for no draft, and also for a draft whose rows read FAILED — in both
   * cases there is no honest count, and the tab carries no count rather than a
   * "0" that would claim there is nothing to publish.
   */
  readonly draftRows: readonly CatalogRow[] | null;
  readonly catalog: readonly CatalogRow[];
  /** Whether the mode's latest publish attempt is one `page.tsx` decided to
   *  surface — which, per `surfacedAttempt`, means exactly "it did not
   *  succeed". The same condition that mounts the alert inside the panel. */
  readonly attemptNeedsAttention: boolean;
}

export function CatalogSurface({
  mode,
  observation,
  browse,
  authoring,
  promoCodes,
  draftRows,
  catalog,
  attemptNeedsAttention,
}: CatalogSurfaceProps) {
  const changed = useMemo(
    () => (draftRows === null ? null : countChangedDraftRows(draftRows, catalog)),
    [draftRows, catalog],
  );

  // Both badges when both apply: a draft with edits waiting AND a previous
  // attempt that did not succeed are two separate things an operator needs to
  // know, and showing only one of them would hide the other.
  const draftBadge =
    attemptNeedsAttention || (changed !== null && changed > 0) ? (
      <>
        {changed !== null && changed > 0 ? <ChangedBadge count={changed} /> : null}
        {attemptNeedsAttention ? <AttentionBadge /> : null}
      </>
    ) : undefined;

  return (
    <div className="flex flex-col gap-6">
      {/* One line by default (see `observation-strip.tsx`): this was the first
          thing on the page and pushed everything an operator came to do below
          the fold. */}
      <section className="flex flex-col gap-3" aria-label="Observation window">
        {observation}
      </section>

      <div className="flex items-center justify-end">
        <ModeToggle mode={mode} />
      </div>

      {/* A distinct `label` from the per-plan tabs nested inside Browse
          (`PlanCatalogTabs`, "Plan catalog, by plan") and from the two pill
          rows that also carry `role="tablist"` — the mode toggle and the
          source filter. Four tablists on one page is only navigable if each
          announces what it switches. */}
      <SurfaceTabs
        label="Plan catalog surface"
        tabs={[
          { id: "browse", label: "Browse", content: browse },
          {
            id: "draft",
            label: "Draft & Publish",
            badge: draftBadge,
            content: authoring,
          },
          { id: "promo", label: "Promo codes", content: promoCodes },
        ]}
      />
    </div>
  );
}
