// See page-header.tsx: `@tesserix/web`'s barrel is "use client", so `StatTile`
// and `SurfaceStateView` are client components a server component cannot
// compose as JSX. This file carries its own directive for that reason.
"use client";

import { StatTile } from "@/components/kit/stat-tile";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
// `import type` only: `onboarding-funnel.ts` imports `PlatformApiError`, and a
// VALUE import of that class from a client component is how `pg` reached the
// browser bundle once already (see `lib/platform-api-error.ts`'s header).
import type { OnboardingFunnel } from "@/lib/onboarding-funnel";

export interface FunnelViewProps {
  /** `null` whenever `state.kind !== "ready"` — see `page.tsx`'s
   *  `funnelState`. A funnel is rendered only when one was actually read. */
  funnel: OnboardingFunnel | null;
  /** The product this funnel belongs to, named on the page because the stage
   *  words below are ITS vocabulary and not the console's. */
  source: string;
  state: SurfaceState;
  reauthReturnTo: string;
}

/**
 * A stage name for display: the product's own word, underscores opened up.
 *
 * Presentation only, and reversible by eye — the same transform
 * `ai-metrics-view.tsx`'s `kindLabel` applies to Kora's outcome kinds, and for
 * the same reason. A lookup table mapping `email_verified` to "Email
 * verified — confirmed their address" would be a console-side vocabulary that
 * drifts from mark8ly's the first time mark8ly changes what the stage means.
 */
export function stageLabel(stage: string): string {
  return stage.replace(/_/g, " ");
}

/**
 * The median as copy — and the ONE place `null` is turned into words.
 *
 * `null` means NOT MEASURABLE: no session completed in the window, so there is
 * no median to state. It is not zero, and there is deliberately no `?? 0`
 * anywhere near this function — a zero here reads as "onboarding completes
 * instantly", which is the most flattering possible lie about a funnel nobody
 * finished. A real 0 is left to format as a duration, so the two stay
 * distinguishable on the page as well as in the type.
 */
export function formatMedianCompletion(seconds: number | null): string {
  if (seconds === null) return "Not measurable";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${whole % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One product's onboarding funnel.
 *
 * # Nothing renders unless a funnel was read
 *
 * #404's second rule — "a stage with zero is a measurement; a funnel that
 * could not be read is not" — is enforced structurally here: every tile below
 * lives inside `funnel ? … : null`, so there is no path on which a failed,
 * parked or unauthenticated read produces a grid of zeroes. The non-ready
 * states get `SurfaceStateView` and nothing else, and the 501 among them
 * arrives as a calm callout rather than an error, because a deployment that
 * federates no funnel is not broken.
 *
 * # The stages are whatever the product sent
 *
 * `funnel.stages` is rendered in order, whole. There is no console-side list
 * of stage names to compare against, so a stage this build has never heard of
 * renders exactly like the five it has — see `lib/onboarding-funnel.ts`.
 */
export function FunnelView({ funnel, source, state, reauthReturnTo }: FunnelViewProps) {
  return (
    <div className="flex flex-col gap-6">
      <SurfaceStateView
        state={state}
        emptyMessage={`${source} has recorded no onboarding sessions yet.`}
        reauthReturnTo={reauthReturnTo}
      />

      {funnel ? (
        <>
          <p className="text-sm text-muted-foreground" data-testid="funnel-window">
            {/* The window the product ACTUALLY applied, echoed back by it —
                not one this console asked for. Stated rather than implied, so
                nobody reads these counts as all-time. */}
            {source}, {funnel.window.from} to {funnel.window.to}
          </p>

          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {funnel.stages.map((stage) => (
              <div key={stage.stage} data-testid="funnel-stage" data-stage={stage.stage}>
                <StatTile label={stageLabel(stage.stage)} value={stage.count} />
              </div>
            ))}
            <StatTile
              label="Median completion"
              value={formatMedianCompletion(funnel.medianCompletionSeconds)}
            />
          </section>

          <section className="flex flex-col gap-2" data-testid="funnel-pulse">
            <h2 className="text-sm font-medium">Last 24 hours</h2>
            {/* TWO tiles, not five. mark8ly projects the pulse through a
                deliberately narrower row — the contract pins started and
                completed only — so the other three counters do not exist here
                and printing them as zeroes would invent measurements. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <StatTile label="Started" value={funnel.last24h.started} />
              <StatTile label="Completed" value={funnel.last24h.completed} />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
