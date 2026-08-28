// `StatTile` and `SurfaceStateView` are NOT re-exports of `@tesserix/web` —
// each is its own `"use client"` component that imports from that barrel
// (see `stat-tile.tsx:1-4`, which explains why its own directive is
// load-bearing: the barrel is `"use client"`, so its exports read as
// `undefined` inside a server component). Because they carry the directive
// themselves, a server component could compose them as JSX without this
// file having one.
//
// This file has one anyway, deliberately: it decides `reauthRequired` from
// four independent states, which is exactly the composition the food index
// and the support-analytics panel keep in a client half. Consistent with
// `food-index.tsx`'s own directive.
"use client";

import { StatTile } from "@/components/kit/stat-tile";
import { SurfaceStateView } from "@/components/kit/states";
// `import type` only — never a value import. `surface-state.ts` and
// `kora-ai-metrics.ts` are both reachable from server-only modules
// (`lib/platform-api.ts` -> `lib/auth/platform-token` -> `pg`), and a client
// component importing a VALUE from either would drag that chain into the
// browser bundle. tsc and vitest cannot see this; only `next build` fails —
// see the plan's own warning and `catalog/page.tsx`'s identical trap.
import type { SurfaceState } from "@/components/kit/surface-state";
import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";

/**
 * The client half of Kora's overview — four independent stat tiles, each
 * carrying its OWN `SurfaceState` so one failed read renders its own tile's
 * "not measured" or "could not load" without blanking the other three. The
 * page (`page.tsx`) stays a server component; this file exists only because
 * `reauthRequired` below has to be decided by reading four props together,
 * the same reason `AnalyticsPanel` (tickets) is a component rather than
 * inline JSX in its page.
 */

export interface KoraOverviewProps {
  foodsTotal: number | null;
  foodsState: SurfaceState;
  usersTotal: number | null;
  usersState: SurfaceState;
  needsAttentionTotal: number | null;
  needsAttentionState: SurfaceState;
  aiMetrics: KoraAiMetrics | null;
  aiMetricsState: SurfaceState;
  /** Where to send the operator back to after re-authenticating. */
  reauthReturnTo: string;
}

/**
 * Copy for Kora's `first_try_rate_pct` — the single most likely way this
 * page could ship a lie. Kora returns the field ABSENT, not `0.0`, when the
 * measurement window had no attempts to score (`ai_metrics.go:37-45`,
 * deliberate on Kora's side). `undefined` must read as "not measured", never
 * as a confident zero — a dashboard asserting 0% for a window that measured
 * nothing is worse than one that says plainly it measured nothing.
 */
export function formatFirstTryRate(pct: number | undefined): string {
  if (pct === undefined) return "Not measured";
  return `${Math.round(pct)}%`;
}

export function KoraOverview({
  foodsTotal,
  foodsState,
  usersTotal,
  usersState,
  needsAttentionTotal,
  needsAttentionState,
  aiMetrics,
  aiMetricsState,
  reauthReturnTo,
}: KoraOverviewProps) {
  // Answered ONCE here, not up to four times: `StatTile` has no case for
  // `reauth-required` (it falls through to its dash-only default), and
  // `AnalyticsPanel` (tickets) already establishes that a single banner
  // above a grid of tiles is the right place for this — four identical
  // "sign in again" prompts under one page would be the stacking that
  // pattern exists to avoid.
  const reauthRequired =
    foodsState.kind === "reauth-required" ||
    usersState.kind === "reauth-required" ||
    needsAttentionState.kind === "reauth-required" ||
    aiMetricsState.kind === "reauth-required";

  // `undefined` when `aiMetrics` is present so `StatTile` falls back to its
  // own `ready` default rather than being handed a state object this
  // component would otherwise have to keep in lock-step with `aiMetrics`.
  const aiTileState = aiMetrics ? undefined : aiMetricsState;

  return (
    <div className="flex flex-col gap-8">
      {reauthRequired ? (
        <SurfaceStateView
          state={{ kind: "reauth-required" }}
          emptyMessage=""
          reauthReturnTo={reauthReturnTo}
        />
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Kora at a glance">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile label="Foods" value={foodsTotal ?? ""} state={foodsState} href="/kora/foods" />
          <StatTile label="Users" value={usersTotal ?? ""} state={usersState} href="/kora/users" />
          <StatTile
            label="Needs attention"
            value={needsAttentionTotal ?? ""}
            delta="unresolved foods and feedback"
            state={needsAttentionState}
            href="/platform/inbox"
          />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="AI resolution">
        <h3 className="text-sm font-medium">AI resolution</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile
            label="Resolution attempts"
            value={aiMetrics ? aiMetrics.outcomes.attempts : ""}
            state={aiTileState}
          />
          <StatTile
            label="Needs human"
            value={aiMetrics ? aiMetrics.outcomes.needsHuman : ""}
            state={aiTileState}
          />
          {/* THE tile the plan calls out: `formatFirstTryRate` is the only
              place `firstTryRatePct` is turned into copy, and it never
              defaults an absent rate to a number. */}
          <StatTile
            label="First-try rate"
            value={aiMetrics ? formatFirstTryRate(aiMetrics.outcomes.firstTryRatePct) : ""}
            state={aiTileState}
          />
        </div>
      </section>
    </div>
  );
}
