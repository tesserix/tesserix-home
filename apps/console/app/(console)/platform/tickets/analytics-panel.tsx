import { StatTile } from "@/components/kit/stat-tile";
import { RankedBars } from "@/components/kit/ranked-bars";
import type { SurfaceState } from "@/components/kit/surface-state";
// `states`, not `surface-state`: this module is composed into a server
// component (`page.tsx`) without a directive of its own, same as `StatTile`
// and `RankedBars` already are — only `SurfaceStateView` is rendered
// directly here (as JSX, never called), so no directive is needed for that
// either.
import { SurfaceStateView } from "@/components/kit/states";
import {
  formatCsat,
  formatResolutionTime,
  formatResolvedRate,
  formatShare,
  type SupportAnalytics,
} from "@/lib/support-analytics";

/**
 * Support analytics — otto's cross-tenant conversation rollup.
 *
 * A server component: it only composes client components, never calls into
 * them, so nothing here needs a `"use client"` directive.
 *
 * apps/web polls this every 30 seconds via SWR. The console reads it once per
 * navigation instead. That is a real reduction in liveness, taken knowingly for
 * v1: the numbers are hour-scale rollups, and introducing SWR here would make
 * this the only polling surface in a server-rendered console.
 */

export interface AnalyticsPanelProps {
  data: SupportAnalytics | null;
  /** Non-ready when the analytics read failed — independently of the queue. */
  state: SurfaceState;
  /** Forwarded to the single reauth-required prompt below. */
  reauthReturnTo?: string;
}

export function AnalyticsPanel({ data, state, reauthReturnTo }: AnalyticsPanelProps) {
  // Every tile takes the shared state when there is no data, so a 501 renders
  // as "Not measured" eight times rather than eight zeroes.
  const tileState = data ? undefined : state;
  const breakdownState = data ? undefined : state;

  // Unlike a 501 (each `StatTile` already renders its own compact "Not
  // measured" note, and repeating that eight times is the existing,
  // accepted shape of this panel), `reauth-required` is answered here ONCE:
  // `breakdownState` is the same object handed to all three `RankedBars`
  // below, each of which renders a full `SurfaceStateView` callout for a
  // non-ready state — three identical "sign in again" prompts under one
  // panel would be exactly the stacking `CrmQueueView` exists to avoid, one
  // level down. `RankedBars` is told to suppress its own copy of this one
  // kind via `suppressReauthPrompt`.
  const reauthRequired = !data && state.kind === "reauth-required";

  return (
    <div className="flex flex-col gap-8">
      {reauthRequired ? (
        <SurfaceStateView
          state={{ kind: "reauth-required" }}
          emptyMessage=""
          reauthReturnTo={reauthReturnTo}
        />
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Volume">
        <h3 className="text-sm font-medium">Volume</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Total conversations"
            value={data ? data.total.toLocaleString() : ""}
            state={tileState}
          />
          <StatTile
            label="Open"
            value={data ? data.open.toLocaleString() : ""}
            delta="pending + active"
            state={tileState}
          />
          <StatTile
            label="AI-resolved"
            value={data ? data.aiResolved.toLocaleString() : ""}
            delta={data ? `${formatShare(data.aiResolved, data.total)} of all` : undefined}
            state={tileState}
          />
          <StatTile
            label="Escalated to human"
            value={data ? data.escalated.toLocaleString() : ""}
            delta={data ? `${formatShare(data.escalated, data.total)} of all` : undefined}
            state={tileState}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="Quality and efficiency">
        <h3 className="text-sm font-medium">Quality &amp; efficiency</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Avg resolution time"
            value={data ? formatResolutionTime(data.avgResolutionSeconds) : ""}
            delta="created → closed"
            state={tileState}
          />
          {/* CSAT and resolved rate read "—" with no feedback rather than 0:
              apps/web's tone thresholds are not ported, because a colour that
              says "critical" for an unrated week is a false alarm. */}
          <StatTile
            label="CSAT"
            value={data ? formatCsat(data.csat, data.feedbackCount) : ""}
            delta="post-case rating"
            state={tileState}
          />
          <StatTile
            label="Resolved rate"
            value={data ? formatResolvedRate(data.resolvedRate, data.feedbackCount) : ""}
            delta="customer-reported"
            state={tileState}
          />
          <StatTile
            label="Feedback responses"
            value={data ? data.feedbackCount.toLocaleString() : ""}
            state={tileState}
          />
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-3">
        <RankedBars
          title="By status"
          description="Conversation lifecycle distribution"
          rows={data?.byStatus ?? []}
          emptyMessage="No conversations yet."
          state={breakdownState}
          reauthReturnTo={reauthReturnTo}
          suppressReauthPrompt={reauthRequired}
        />
        <RankedBars
          title="By reason"
          description="Why customers reached out"
          rows={data?.byReason ?? []}
          emptyMessage="No reasons recorded."
          state={breakdownState}
          reauthReturnTo={reauthReturnTo}
          suppressReauthPrompt={reauthRequired}
        />
        <RankedBars
          title="By tenant"
          description="Volume per store or product"
          rows={data?.byTenant ?? []}
          emptyMessage="No tenants yet."
          state={breakdownState}
          reauthReturnTo={reauthReturnTo}
          suppressReauthPrompt={reauthRequired}
        />
      </div>
    </div>
  );
}
