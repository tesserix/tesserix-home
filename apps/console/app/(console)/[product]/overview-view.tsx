// `StatTile` and `SurfaceStateView` each carry their own `"use client"` (see
// `stat-tile.tsx:1-4`), so a server component could compose them as JSX
// without this file having a directive of its own.
//
// This file has one because `metricLabel` and `metricValueText` are called
// from inside the `.map()` below, and this is where the product's own metric
// keys are turned into copy — the same split `kora/overview-view.tsx` makes
// for `formatFirstTryRate`. Keeping the pure functions beside the markup they
// serve, in a client module, keeps the page a server component with no
// rendering logic in it.
"use client";

import { StatTile } from "@/components/kit/stat-tile";
import { SurfaceStateView } from "@/components/kit/states";
// `import type` only — never a value import. `surface-state.ts` and `kpis.ts`
// are both reachable from server-only modules (`lib/platform-api.ts` ->
// `lib/auth/platform-token` -> `pg`), and a client component importing a VALUE
// from either would drag that chain into the browser bundle. tsc and vitest
// cannot see this; only `next build` fails — see `kora/overview-view.tsx`'s
// identical note.
import type { SurfaceState } from "@/components/kit/surface-state";
import type { MetricValue, ProductKpis } from "@/lib/kpis";

/**
 * The client half of the generic product overview: one `StatTile` per metric
 * the product reported, and the surface's own state above them.
 *
 * ONE read, so ONE state — unlike `kora/overview-view.tsx`, whose four tiles
 * each carry their own. §3.1 answers a product's whole metrics map in a single
 * response, so there is no per-tile failure to render: either the map arrived
 * or nothing did.
 */

/**
 * A metric key as a human reads it: `orders_today` -> "Orders today".
 *
 * # What it does, and what it deliberately does not
 *
 * Underscores and hyphens become spaces and the first letter is capitalised.
 * That is all. The rest of the key is left exactly as the product wrote it.
 *
 * It does NOT split camelCase and it does NOT expand or re-case anything else:
 * `mrr_usd` renders "Mrr usd" rather than "MRR (USD)". The keys are the
 * product's own and are not enumerated anywhere in the console — `ProductKpis`
 * says so, and platform-api carries the map through without knowing them
 * either — so any prettier rule would be the console guessing at vocabulary it
 * has no source for, and guessing wrong is worse here than being plain.
 *
 * Falls back to the raw key when the derivation would leave nothing, so a tile
 * can never render a blank label. `parseProductKpis` accepts any string key,
 * including `""` and `"__"`.
 */
export function metricLabel(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  if (spaced === "") return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * One metric value as tile text.
 *
 * `StatTile` takes `string | number | Money`, so a boolean has to be turned
 * into text somewhere. It becomes "true"/"false" — the product's own value
 * spelled out — rather than "Yes"/"No": a bool metric's meaning belongs to the
 * product, and this surface knows neither the key's polarity nor whether it is
 * even a yes/no question, so any friendlier wording would be a reading the
 * console cannot back.
 *
 * Numbers pass through as numbers so `StatTile`'s `tabular-nums` formatting
 * applies to them, and strings pass through unchanged.
 */
export function metricValueText(value: MetricValue): string | number {
  return typeof value === "boolean" ? String(value) : value;
}

export interface ProductOverviewProps {
  /** Display name, for the section's accessible label. */
  productLabel: string;
  /** The metrics map, or `null` when the read did not produce one. */
  metrics: ProductKpis | null;
  state: SurfaceState;
  /** Where to send the operator back to after re-authenticating. */
  reauthReturnTo: string;
}

export function ProductOverview({
  productLabel,
  metrics,
  state,
  reauthReturnTo,
}: ProductOverviewProps) {
  return (
    <div className="flex flex-col gap-8">
      {/* Renders `null` for `ready`, so it sits above the tiles
          unconditionally — the 501 callout in particular is this surface's
          whole answer, and its copy is carried on the state by
          `kpisReadError`. */}
      <SurfaceStateView
        state={state}
        // Reached only if a product answers 200 with a map this surface reads
        // as no rows. `parseProductKpis` rejects `{}` outright, so I know of
        // no path that produces this today; the copy is here because
        // `SurfaceStateView` requires it, and it says the one thing that
        // would be true.
        emptyMessage="This product reported no metrics."
        reauthReturnTo={reauthReturnTo}
      />

      {metrics ? (
        <section className="flex flex-col gap-3" aria-label={`${productLabel} headline metrics`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(metrics).map(([key, value]) => (
              // Keyed on the metric key, which is unique by construction —
              // `metrics` is an object, so two tiles cannot share one.
              <StatTile key={key} label={metricLabel(key)} value={metricValueText(value)} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
