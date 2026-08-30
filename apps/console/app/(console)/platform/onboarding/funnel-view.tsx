// See page-header.tsx: `@tesserix/web`'s barrel is "use client", so `StatTile`
// and `SurfaceStateView` are client components a server component cannot
// compose as JSX. This file carries its own directive for that reason.
"use client";

import Link from "next/link";
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
  /**
   * The product this funnel belongs to, named on the page because the stage
   * words below are ITS vocabulary and not the console's.
   *
   * `null` when no product was chosen — nobody declares `onboarding`, the
   * declarations could not be read, or the URL named a product that does not
   * declare one. In every one of those `funnel` is null too, so nothing that
   * needs a name renders.
   */
  source: string | null;
  /**
   * Every product declaring `onboarding` on this deployment, in the API's own
   * sorted order — see `SourcePicker` for what is done with one of them.
   */
  sources: readonly string[];
  /** Where the picker's chips point. */
  basePath: string;
  state: SurfaceState;
  reauthReturnTo: string;
}

/**
 * The source picker: one chip per product declaring `onboarding`.
 *
 * # It renders NOTHING for a single source, and that is the design
 *
 * The list comes from the deployment's declarations either way — that is the
 * point of the read, and it is what makes a second product appear here without
 * a console change. What is conditional is the CONTROL, because a lone chip is
 * a control that cannot do anything: there is nothing to switch to and
 * nothing to deselect, so it reads as a filter an operator has failed to clear.
 * The one source is still named on the page, on the window line below, which
 * is where it belongs when there is no choice to make.
 *
 * So today, with only mark8ly declaring, this renders nothing. The day a
 * second product declares, chips appear — the list was never the thing that
 * was missing.
 *
 * # Links, not buttons
 *
 * A chosen source is a location: it must be shareable, bookmarkable and
 * back-button-navigable, the same call `ResultPager` makes about a page of
 * results.
 */
export function SourcePicker({
  sources,
  selected,
  basePath,
}: {
  sources: readonly string[];
  selected: string | null;
  basePath: string;
}) {
  if (sources.length < 2) return null;
  return (
    <nav aria-label="Onboarding source" className="flex flex-wrap items-center gap-2">
      {sources.map((slug) => {
        const current = slug === selected;
        return (
          <Link
            key={slug}
            href={`${basePath}?source=${encodeURIComponent(slug)}`}
            // `aria-current="page"` rather than a disabled control: the chosen
            // chip stays a link so a screen-reader user hears which one is
            // active without losing the ability to land on it directly.
            aria-current={current ? "page" : undefined}
            data-testid="funnel-source"
            data-selected={current ? "true" : "false"}
            className={
              current
                ? "rounded-full border border-foreground/20 bg-muted px-3 py-1 text-sm font-medium"
                : "rounded-full border border-transparent px-3 py-1 text-sm text-muted-foreground hover:border-foreground/20"
            }
          >
            {slug}
          </Link>
        );
      })}
    </nav>
  );
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
/**
 * What the counts cover, in words.
 *
 * `window` is the EFFECTIVE bound the product applied, and mark8ly leaves both
 * ends empty when it applied none — this console sends no `created_from` or
 * `created_to`, so that is the ordinary case rather than an error. Interpolating
 * the empty strings rendered "mark8ly, to", a fragment that says nothing and
 * looks broken (observed in production 2026-08-30).
 *
 * An unbounded window means the counts are all-time, so SAY all-time. The line
 * exists precisely so nobody has to guess what a number covers; a half-written
 * range is worse than no line at all, because it looks like a date failed to
 * load rather than like there was never a bound.
 *
 * A one-sided bound is reported as the bound that exists rather than being
 * flattened into "all time", which would be wrong in the half that IS bounded.
 */
export function windowLabel(window: { readonly from: string; readonly to: string }): string {
  const from = window.from.trim();
  const to = window.to.trim();
  if (!from && !to) return "all time";
  if (from && !to) return `from ${from}`;
  if (!from && to) return `up to ${to}`;
  return `${from} to ${to}`;
}

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
export function FunnelView({
  funnel,
  source,
  sources,
  basePath,
  state,
  reauthReturnTo,
}: FunnelViewProps) {
  return (
    <div className="flex flex-col gap-6">
      {/* Above the state view, and outside its branches: when a product's
          funnel fails to read, the way out is to try another product, so the
          picker must survive the failure it is the remedy for. */}
      <SourcePicker sources={sources} selected={source} basePath={basePath} />

      <SurfaceStateView
        state={state}
        emptyMessage={
          // Only a chosen product can be said to have recorded nothing. With
          // no source the empty state is unreachable anyway (no read was
          // made), and "null has recorded no sessions" is the string that
          // reaches an operator if that ever stops being true.
          source
            ? `${source} has recorded no onboarding sessions yet.`
            : "No onboarding sessions to show."
        }
        reauthReturnTo={reauthReturnTo}
      />

      {funnel ? (
        <>
          <p className="text-sm text-muted-foreground" data-testid="funnel-window">
            {/* The window the product ACTUALLY applied, echoed back by it —
                not one this console asked for. Stated rather than implied, so
                nobody has to guess what these counts cover. */}
            {source}, {windowLabel(funnel.window)}
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
