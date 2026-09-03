import { notFound } from "next/navigation";
import { productLabel, productSource } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass. See
// `kora/page.tsx`'s identical comment.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
import { kpisReadError, type ProductKpis } from "@/lib/kpis";
import { fetchProductKpis } from "@/lib/platform-api";
import { resolveProductParam } from "./product-param";
import { ProductOverview } from "./overview-view";

/**
 * `/<product>` — any registry product's overview, from one file.
 *
 * This is the console's first generic rail surface: adding a product to
 * `PRODUCTS` (and declaring its route ids) is what makes its overview exist.
 * Kora keeps its bespoke `/kora` page, which is richer than one metrics map —
 * see the routing note below for why that page still wins.
 *
 * # The metric keys are the product's, not the console's
 *
 * `Metrics` is `map[string]any` on the producer and platform-api carries it
 * through, so nothing between the product and this page enumerates the keys.
 * The page renders a tile per key it was given, labelled by `metricLabel`.
 * Values may be number, string or bool — `lib/kpis.ts` explains why narrowing
 * to number would drop a metric the product meant to send.
 *
 * # WHAT `[product]` MATCHES, as measured rather than assumed
 *
 * `routing.test.ts` runs Next's own route sorter and matcher over the page
 * files in `app/`, and reports what they resolve. What it observed:
 *
 *   - `/kora` resolves to `/kora`, not `/[product]` — the static segment wins.
 *   - `/platform` resolves to `/[product]` with `product: "platform"`. It has
 *     no `page.tsx` of its own, so adding this file gave a previously-404
 *     path a match.
 *   - `/platform/inbox` resolves to `/platform/inbox`. `/platform/nope`
 *     resolved to nothing while `/[product]` was the only dynamic route,
 *     which was a segment-count fact rather than evidence about fall-through
 *     — and `[product]/[entity]` has since settled the question: it now
 *     resolves to `/[product]/[entity]`, and `resolveEntitySurface` refuses
 *     it. `routing.test.ts` measures both depths.
 *
 * `/platform` landing here is exactly why `resolveProductParam` is the first
 * thing this page does. `platform` is not in `PRODUCTS` (`products.ts` says
 * why it must not become one), so it renders `not-found.tsx`.
 *
 * # 501 is not an error here
 *
 * `kpisReadError` — not `toSurfaceError` — narrows the rejection, because it
 * attaches this read's own 501 copy. The kit's default says the observability
 * data plane is parked and points at `docs/observability-park.md`, which is
 * the wrong place to send an operator: a 501 here means the product reports no
 * headline metrics, or that this deployment federates nothing. Both are
 * documented on `KPIS_UNAVAILABLE_MESSAGE`. Kora answers 501 today, so this is
 * live behaviour rather than a rare branch.
 *
 * A 503 stays an `error`, which is the direction that matters: it means the
 * product could not be reached, and rendering that as "no metrics" would tell
 * an operator a number does not exist when it exists and cannot be read.
 */

/**
 * The surface's state, from the one read.
 *
 * Rows are the metric KEYS, so a map that arrived with numbers in it resolves
 * `ready` and an absent map resolves through the error branches.
 * `parseProductKpis` already refuses an empty map, so `empty` is not a state
 * this read is expected to produce — see `ProductOverview`'s `emptyMessage`.
 *
 * `filtered` is always `false`: this surface has no filter to be narrowed by.
 */
export function overviewState(caught: unknown, kpis: ProductKpis | null): SurfaceState {
  return resolveState({
    isLoading: false,
    error: kpisReadError(caught),
    rows: kpis ? Object.keys(kpis) : [],
    filtered: false,
  });
}

export default async function ProductOverviewPage({
  params,
}: {
  params: Promise<{ product: string }>;
}) {
  const { product } = await params;
  const id = resolveProductParam(product);
  // Before any read: an unknown segment must not become a platform-api
  // request, and `notFound()` throws to unwind the render.
  if (id === null) notFound();

  // `productSource(id)`, not the route param and not `estate.ts`'s `context`:
  // the registry's `source` is the literal federation slug on the wire, and
  // `ProductEntry.source` records why it is declared rather than derived.
  //
  // ONE read, not `kora/page.tsx`'s four — there is no sibling read here to
  // protect from this one. `allSettled` all the same, for the value/rejection
  // pair it hands back: the alternative is a reassigned `let` per branch, and
  // this file has an immutability rule to keep.
  const [settled] = await Promise.allSettled([fetchProductKpis(productSource(id))]);
  const kpis = settled.status === "fulfilled" ? settled.value : null;
  const caught = settled.status === "rejected" ? settled.reason : null;
  const state = overviewState(caught, kpis);

  const label = productLabel(id);

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Overview"
        description={`${label}'s headline numbers, as ${label} reports them.`}
      />

      <ProductOverview
        productLabel={label}
        metrics={state.kind === "ready" ? kpis : null}
        state={state}
        reauthReturnTo={`/${id}`}
      />
    </div>
  );
}
