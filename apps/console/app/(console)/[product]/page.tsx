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
import { fetchPlatformSources, fetchProductKpis } from "@/lib/platform-api";
import { declarationsMention } from "@/lib/platform-sources";
import {
  BAD_REQUEST,
  notFederatedMessage,
  notFederatedState,
  notFederatedTitle,
} from "./federation-scope";
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
 *
 * # Nor is an unfederated product, which the API now says with a 501 (#546)
 *
 * `/v1/kpis` is scoped to `FEDERATION_PRODUCTS`, and every way of falling
 * outside that scope is now a 501 with its own message: `ErrNoProducts` when
 * the list is empty, `ErrUnknownSource` when it is non-empty and omits this
 * slug — the likelier deployment, one product federated and another not. So
 * the calm state arrives through `resolveState` without this page concluding
 * anything.
 *
 * It used to be a 400, which `resolveState` renders as a failure, and the gate
 * below is what covered that. Kept because a console can be serving against a
 * platform-api that predates the change; it is a fallback, not the fix.
 *
 * # Why the declarations cannot decide this on their own
 *
 * `/platform/onboarding` reads `/v1/platform/sources` first and treats its
 * answer as the whole truth about which products it may ask. This page cannot:
 * `sources` is the inversion of `FEDERATION_<SLUG>_ENDPOINTS` and `_ENTITIES`,
 * both OPTIONAL in `registry.go`, while `/v1/kpis` is scoped to
 * `FEDERATION_PRODUCTS` itself. So a federated product that declares no
 * endpoints and no entity types is absent from `sources` while its KPIs read
 * perfectly well, and a gate that concluded on its own would render "not
 * federated" over real numbers. The sibling `[entity]` page has no such gap —
 * its gate reads the very map platform-api gates on, so it concludes without
 * corroboration.
 *
 * The declarations are therefore read IN PARALLEL with the KPIs and used only
 * to interpret a 400 that already happened. Two signals, not one: the API
 * refused this slug, and the deployment declares nothing for it.
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
export interface FederationCheck {
  /**
   * Whether ANY of this deployment's declarations mention the product's slug.
   *
   * `false` is not by itself a claim that the product is unfederated —
   * `declarationsMention` is a lower bound, for the reason its own comment
   * gives — which is why the branch below also requires a refusal.
   */
  readonly declared: boolean;
  /** The product's display name, for the callout copy. */
  readonly label: string;
}

/**
 * @param federation the deployment's declarations, or `null` when they could
 * not be read. `null` means nothing is concluded from them: a failed sources
 * read is the absence of a fact, not the fact that nothing is declared, and
 * `fetchPlatformSources`'s own comment says a caller must not confuse the two.
 */
export function overviewState(
  caught: unknown,
  kpis: ProductKpis | null,
  federation: FederationCheck | null = null,
): SurfaceState {
  const error = kpisReadError(caught);
  // The conjunction, and both halves are load-bearing. A 400 alone could be
  // some other refusal, and an absent declaration alone is compatible with a
  // product whose KPIs read fine. Together they are only one thing: this
  // deployment has no route to this product. Every other status is left
  // exactly as it was — a 503 in particular must stay an `error`.
  if (error !== null && error.status === BAD_REQUEST && federation !== null && !federation.declared) {
    return notFederatedState(
      notFederatedTitle(federation.label),
      notFederatedMessage(federation.label),
    );
  }
  return resolveState({
    isLoading: false,
    error,
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
  const source = productSource(id);
  const label = productLabel(id);

  // TWO reads, issued together. The declarations are not a precondition of the
  // KPI read here — see the note above on why this surface interprets rather
  // than gates — so serialising them would add a round trip to every load for
  // a fact only one branch consumes.
  //
  // `allSettled` for the value/rejection pair it hands back, and because the
  // two must not take each other down: a KPI read that failed is exactly when
  // the declarations are worth having, and a declarations read that failed
  // must leave the KPI answer intact.
  const [kpisSettled, sourcesSettled] = await Promise.allSettled([
    fetchProductKpis(source),
    fetchPlatformSources(),
  ]);
  const kpis = kpisSettled.status === "fulfilled" ? kpisSettled.value : null;
  const caught = kpisSettled.status === "rejected" ? kpisSettled.reason : null;
  // A rejected sources read becomes `null`, never `declared: false`. The read
  // failing says nothing about what the deployment declares, and treating it
  // as "declares nothing" would put a confident "not federated" callout over a
  // read that may have failed for an unrelated reason.
  const state = overviewState(
    caught,
    kpis,
    sourcesSettled.status === "fulfilled"
      ? { declared: declarationsMention(sourcesSettled.value, source), label }
      : null,
  );

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
