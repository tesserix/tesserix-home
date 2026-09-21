import { RankedBars, type RankedBarRow } from "@/components/kit/ranked-bars";
import { QueueList, type QueueItem } from "@/components/kit/queue-list";
// Imported from `surface-state` and not from `states`, for the reason
// `page.tsx` records: this module renders on the server.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
import { dbReadError } from "@/lib/db-read-error";
import { funnelSummary, type FunnelSummary, type StalledRow } from "@/lib/db/crm-repo";
import type { CrmStage } from "@/lib/crm";
import { productLabel } from "./product-label";

/**
 * The Funnel tab: the shape of the pipeline, and the deals that are not
 * moving through it (#250).
 *
 * A tab and not a band on the Work tab. `tabHref`'s doc comment records the
 * rule these tabs are built on — they are real navigation, and only the
 * active tab's data is ever read — and a band on Work would make every visit
 * to the follow-up queue pay for an aggregate nobody asked for.
 *
 * Its own module rather than a section of `page.tsx`, for the reason
 * `handoff-tab.tsx` gives: that file already carries the filters, the tab
 * machinery and the Work tab.
 *
 * NO FILTER BAR, and that is a decision rather than an omission. The other
 * three tabs filter a LIST, where "matching rows only" is the obvious
 * reading. This tab states a breakdown, and a breakdown under a filter reads
 * as the whole when it is a slice — "12 qualified" with `?owner=Priya`
 * silently on is the number someone quotes in a meeting. Filters stay on the
 * URL and survive a round trip through here (`tabHref` copies every param),
 * so nothing is lost by not applying them.
 */

const STAGE_LABELS: Record<CrmStage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  won: "Won",
  lost: "Lost",
};

/** The `empty` copy for each half of this tab, exported so tests assert on
 *  the strings the page ships rather than second copies that could drift. */
export const FUNNEL_EMPTY_MESSAGE =
  "No opportunities yet. The pipeline's shape will appear here as leads are worked.";
export const STALLED_EMPTY_MESSAGE =
  "Nothing is sitting still. Every open deal has moved recently.";

/**
 * The stage counts as the breakdown reads them.
 *
 * In `CRM_STAGES` order — which `funnelSummary` fixes — and NOT sorted by
 * size, despite the component being called `RankedBars`: the funnel's own
 * order is the information here. A breakdown that put `lost` first because
 * it happened to be the largest would make the pipeline unreadable as a
 * pipeline.
 */
export function toBreakdownRows(summary: FunnelSummary): RankedBarRow[] {
  return summary.counts.map((entry) => ({
    key: entry.stage,
    label: STAGE_LABELS[entry.stage],
    count: entry.count,
    share: entry.share,
  }));
}

/**
 * A stalled deal as the queue reads it.
 *
 * `waitingSince` is the stage's own clock — `since` — and not the deal's
 * `last_contacted_at` or its `next_action_at`: this list answers "how long
 * has this sat where it is", which is a different question from the two the
 * work queues ask, and reusing either would put a deal that was contacted
 * yesterday at the bottom of a list it belongs at the top of.
 *
 * No `dueAt`: a stalled deal has no deadline to miss, and supplying one
 * would render an SLA this list does not have.
 *
 * Severity is deliberately flat. The list is already ordered by the only
 * ranking it has, and colouring the oldest rows `critical` would assert an
 * escalation policy nothing in the CRM defines.
 */
export function toStalledItem(row: StalledRow): QueueItem {
  return {
    key: row.id,
    title: row.organisationName,
    subtitle: row.owner ? `Owner: ${row.owner}` : undefined,
    product: productLabel(row.product),
    waitingSince: row.since.toISOString(),
    severity: "normal",
    status: { label: STAGE_LABELS[row.stage], tone: "neutral" },
    href: `/platform/crm/${row.organisationId}`,
  };
}

/**
 * The breakdown's state.
 *
 * `empty` when there are no deals at all, rather than five bars each reading
 * zero: the component renders a row per entry and `funnelSummary` always
 * returns all five, so `rows.length` is never 0 and its own empty fallback
 * can never fire. Five zeroes under a heading is noise where one sentence is
 * an answer.
 */
export function breakdownState(error: unknown, total: number): SurfaceState {
  return resolveState({
    isLoading: false,
    error: dbReadError(error, "the funnel"),
    // Stated as the count of DEALS, not of stage entries, so `empty` means
    // "nothing in the pipeline" rather than "the read returned no stages".
    rows: new Array(total),
    // This tab applies no filters, so an empty funnel is never a
    // `filtered-empty` one.
    filtered: false,
  });
}

/**
 * The Funnel tab's content. A plain awaited function, not a nested async
 * component — see `renderWorkTab` in `page.tsx` for the testability reason —
 * and only ever called while this tab is the active one.
 *
 * One `try` around one call, and not two reads settled independently: the
 * breakdown and the stalled list are one answer. `funnelSummary`'s own
 * comment records why a half-failed funnel must not render — a stage
 * breakdown shown beside a stalled list that silently failed reads as "the
 * pipeline is healthy, nothing is stuck".
 */
export async function renderFunnelTab({ reauthReturnTo }: { reauthReturnTo: string }) {
  let summary: FunnelSummary | null = null;
  let error: unknown = null;
  try {
    summary = await funnelSummary();
  } catch (caught) {
    error = caught;
  }

  const breakdown = summary ? toBreakdownRows(summary) : [];
  const stalled = summary ? summary.stalled.map(toStalledItem) : [];
  const state = breakdownState(error, summary?.total ?? 0);

  return (
    <div className="flex flex-col gap-8">
      <RankedBars
        title="By stage"
        description="Open and closed deals, excluding any an operator has voided."
        rows={breakdown}
        emptyMessage={FUNNEL_EMPTY_MESSAGE}
        state={state}
        reauthReturnTo={reauthReturnTo}
        // Five stages, and every one of them is the point — a `limit` that
        // elided any of them would hide a stage rather than trim a tail.
        limit={breakdown.length}
      />

      <section className="flex flex-col gap-3" aria-label="Not moving">
        <div>
          <h3 className="text-sm font-medium">Not moving</h3>
          <p className="text-xs text-muted-foreground">
            Open deals, longest in their current stage first. A deal that has never
            changed stage is counted from the day it was created.
          </p>
        </div>
        <QueueList
          items={stalled}
          // The same state object as the breakdown above, because they come
          // from the same read: `error` is the read's, and `empty` here means
          // the funnel holds no open deals at all.
          state={
            state.kind === "ready" && stalled.length === 0 ? { kind: "empty" } : state
          }
          emptyMessage={STALLED_EMPTY_MESSAGE}
          reauthReturnTo={reauthReturnTo}
          // The breakdown above renders the one "sign in again" callout for
          // this tab; without this, a session with no operator token row
          // would stack a second identical one here.
          suppressReauthPrompt
        />
      </section>
    </div>
  );
}
