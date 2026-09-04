import { notFound } from "next/navigation";
import { productLabel, productSource } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass. Same note as
// `kora/page.tsx` and `[product]/page.tsx`.
import {
  NOT_IMPLEMENTED,
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchPlatformSources, fetchProductEntities } from "@/lib/platform-api";
import { slugsServing, type PlatformSources } from "@/lib/platform-sources";
import {
  notFederatedState,
  typeNotFederatedMessage,
  typeNotFederatedTitle,
} from "../federation-scope";
import type { EntityPage } from "@/lib/entities";
// The shared §3.4 pager: an off-by-one that offers an empty next page should
// have ONE definition and one set of tests, and that module's header says so.
// It lived under `kora/` while Kora's pages were its only callers and moved to
// `components/kit` when this page became a third.
import {
  pageHref,
  pagerLinks,
  readPage,
  type PagerLinks,
} from "@/components/kit/entity-page";
import { resolveEntitySurface } from "./entity-param";
import { EntityIndex } from "./entity-index";

/**
 * `/<product>/<entity>` — any registry product's index for any §3.4 entity
 * type it declares, from one file. `/mark8ly/tenants` and `/mark8ly/users`
 * are served here with no page file of their own.
 *
 * # Why one file can serve every product and every type
 *
 * `EntityRecord` (`lib/entities.ts`) is a NORMALIZED, fixed shape — `id`,
 * `source`, `type`, `label`, optional `sublabel`, optional `createdAt` —
 * because contract §3.4 normalizes it and platform-api answers every product
 * and every type in it. So the columns are the same for `kora`/`foods` as for
 * `mark8ly`/`tenants`, and there is no per-product or per-type column map
 * here. There is deliberately no mechanism for adding one.
 *
 * # Kora's own index pages are untouched and still win
 *
 * `/kora/foods` and `/kora/users` are static routes with their own page files,
 * and Next's route precedence puts a static segment ahead of a dynamic one.
 * `routing.test.ts` measures that rather than asserting it. Kora's food index
 * renders an expandable detail row this page has no equivalent for, so the two
 * are not interchangeable.
 *
 * # WHAT `[product]/[entity]` MATCHES, as measured rather than assumed
 *
 * `routing.test.ts` runs Next's own sorter and matcher over the on-disk page
 * list. Adding this file gave previously-unmatched two-segment URLs a match:
 * `/platform/nope` and `/kora/nope` resolved to nothing before it and resolve
 * here now. `resolveEntitySurface` is the only thing between them and a
 * rendered page — it refuses `platform` (not in `PRODUCT_IDS`) and refuses
 * `nope` (not in `productEntities("kora")`).
 *
 * A `notFound()` raised here is served by `[product]/not-found.tsx`. That was
 * MEASURED for this task, not assumed: a matched pair of production builds of
 * a minimal app with this exact segment shape (Next 16.2.11) rendered that
 * segment's not-found for a nested `[product]/[entity]` refusal, and fell back
 * to the root `not-found` only when the segment file was removed.
 *
 * # 501 is not an error here
 *
 * Same endpoint and same status as Kora's user directory, whose copy this
 * generalises: a 501 means the console's platform API is not configured to
 * read this product's records. Nothing is broken and there is nothing to
 * retry, so it renders as unavailable rather than as a failure.
 *
 * # Neither is an unfederated product, which the API now says with a 501 (#546)
 *
 * `ErrUnknownSource` and `ErrTypeNotServed` are both 501 now, each with its
 * own message, so the 501 copy above covers them and the gate below is a
 * fallback for a console serving against an older platform-api. The paragraph
 * that follows describes what it was written against.
 *
 * platform-api's entities module USED TO answer 501 only for
 * `ErrNotInstrumented` — `len(s.types) == 0`, and that map has a key per
 * FEDERATED PRODUCT, not per product that declared a type: `main.go` writes
 * `types[slug] = product.Entities` for every slug `Registry.Slugs()` returns,
 * and the value may be empty. So that 501 meant "this deployment federates
 * nothing at all", and a deployment federating one product with
 * `FEDERATION_<SLUG>_ENTITIES` unset still had `len(types) == 1`: it answered
 * 400 `ErrTypeNotServed`. `ErrUnknownSource`, for a slug this deployment does
 * not federate, was a 400 too. `resolveState` renders a 400 as a failure, so
 * the likelier deployment read as an outage.
 *
 * That is what the gate below covers, and it is the only thing that covers it
 * against an older API — deleting it as redundant would put that page back for
 * any deployment whose platform-api has not rolled the change out yet.
 *
 * # This surface's gate is EXACT, where `[product]/page.tsx`'s is not
 *
 * `GET /v1/platform/sources` inverts `FEDERATION_<SLUG>_ENTITIES`, and
 * `main.go` builds this route's `Types` map and that route's `Entities` map in
 * two adjacent blocks from the same `product.Entities`. So "is this slug listed
 * for this type" is the very condition `service.Read` gates on, not a proxy for
 * it: a slug absent there is refused, and a slug present there gets past both
 * 400 branches.
 *
 * The overview page has no such congruent map — `/v1/kpis` is scoped to
 * `FEDERATION_PRODUCTS`, which `sources` does not expose — so its gate is a
 * lower bound and it needs a 400 alongside it before it will conclude
 * anything. This one needs no corroboration. The two surfaces differ because
 * the API does, not by accident.
 *
 * # But the read still goes out, in PARALLEL
 *
 * An exact gate could have skipped the request. It does not, because
 * `platformRequest` sets `cache: "no-store"`: awaiting the declarations first
 * would put a real extra round trip on every load of the common, FEDERATED
 * path to save one refused request on the rare unfederated one. So both reads
 * are issued together and the refusal is discarded unread. That is a departure
 * from `/platform/onboarding`, which serialises — it must, because it has no
 * source to ask about until the picker's list arrives, and this page's source
 * comes from the registry.
 */

/** Browse and search, both — the contract's shape since tesserix/kora#480.
 *  A search box rather than a select: the values are the product's, and
 *  enumerating them console-side is a second vocabulary that drifts. */
export const ENTITY_FILTERS: FilterDescriptor[] = [
  { key: "q", label: "Search records", type: "search" },
];

export type EntitySearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the search out of the URL.
 *
 * Written here rather than imported from `kora/users/page.tsx`, which has the
 * same three lines: that copy lives inside a page module whose default export
 * is a route, and importing one helper out of it would couple this surface to
 * Kora's page. The RULE both implement is stated once, on
 * `fetchProductEntities`.
 *
 * A blank `q` is dropped rather than sent: a blank query is a BROWSE, and
 * sending `q=` would filter on the empty string on a product that treats the
 * param as present. Repeated params are ignored — the endpoint takes one value
 * per key.
 */
export function readEntitySearch(searchParams: EntitySearchParams): string | undefined {
  const q = searchParams.q;
  if (typeof q === "string" && q.trim() !== "") return q.trim();
  return undefined;
}

/**
 * An entity type as a heading: `tenants` -> "Tenants".
 *
 * Underscores and hyphens become spaces and the first letter is capitalised —
 * the same derivation, and the same restraint, as `metricLabel` in
 * `[product]/overview-view.tsx`. The types are the PRODUCT's vocabulary,
 * declared per product in `PRODUCTS` and taken by platform-api as
 * `FEDERATION_<SLUG>_ENTITIES`; the console enumerates none of them, so any
 * prettier rule would be it guessing at words it has no source for.
 *
 * Falls back to the raw type when the derivation would leave nothing, so a
 * heading can never render blank.
 */
export function entityTypeLabel(type: string): string {
  const spaced = type.replace(/[_-]+/g, " ").trim();
  if (spaced === "") return type;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function emptyMessage(label: string, type: string): string {
  return `${label} has no ${type} yet.`;
}

export const SCOPE_NOTE = "Search to narrow the list, or page through it.";

export function unavailableTitle(label: string, type: string): string {
  return `${label}'s ${type} are not switched on`;
}

/**
 * Copy for the 501, which is NOT an error.
 *
 * The kit's default points at `docs/observability-park.md` — right for a
 * parked metrics plane, wrong here, where the answer is a config value.
 */
export function unavailableMessage(label: string): string {
  return (
    `The console is not configured to read ${label}'s records yet. Nothing is ` +
    "broken and there is nothing to retry — this surface turns on when the " +
    `platform API is configured with ${label} as a source.`
  );
}

export function entityReadError(
  caught: unknown,
  label: string,
  type: string,
): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: { title: unavailableTitle(label, type), message: unavailableMessage(label) },
  };
}

export interface EntityStateInput {
  readonly error: unknown;
  readonly rows: readonly unknown[];
  readonly filtered: boolean;
  readonly label: string;
  readonly type: string;
}

/** `filtered` is real here: this surface has a search, so "no results — clear
 *  the search" is true and useful, and a different thing from no records. */
export function entityState(input: EntityStateInput): SurfaceState {
  return resolveState({
    isLoading: false,
    error: entityReadError(input.error, input.label, input.type),
    rows: input.rows,
    filtered: input.filtered,
  });
}

const EMPTY_PAGE: EntityPage = { data: [], pagination: { page: 1, limit: 0, total: 0 } };

export default async function ProductEntityIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ product: string; entity: string }>;
  searchParams: Promise<EntitySearchParams>;
}) {
  const { product, entity } = await params;
  const surface = resolveEntitySurface(product, entity);
  // Before any read: an unknown product or an undeclared type must not become
  // a platform-api request, and `notFound()` throws to unwind the render.
  if (surface === null) notFound();

  const resolved = await searchParams;
  const search = readEntitySearch(resolved);
  const pageNumber = readPage(resolved);

  const label = productLabel(surface.product);
  // `productSource(...)`, not the route param: the registry's `source` is the
  // literal federation slug on the wire, and `ProductEntry.source` records why
  // it is declared rather than derived.
  const source = productSource(surface.product);
  const basePath = `/${surface.product}/${surface.type}`;

  // ISSUED TOGETHER, not one after the other. `platformRequest` sets
  // `cache: "no-store"`, so awaiting the declarations first would add a real
  // round trip to every load of the COMMON, federated path in order to save a
  // refused request on the rare one. Parallel costs the opposite way round:
  // one upstream 400 in the case that was going to be refused anyway.
  //
  // `allSettled` because neither may take the other down — a rejected
  // declarations read must leave a good index standing, and a rejected entity
  // read is exactly when the declarations are worth having.
  const [sourcesSettled, entitiesSettled] = await Promise.allSettled([
    fetchPlatformSources(),
    // `source`, `surface.type`: both come from the registry, never from the
    // raw params.
    fetchProductEntities(source, surface.type, search, pageNumber),
  ]);

  // `null` — the declarations went unread — is deliberately NOT `false`. Only
  // a positive "this deployment declares no such thing" can explain a refusal;
  // the absence of an answer must not become a confident one.
  const sources: PlatformSources | null =
    sourcesSettled.status === "fulfilled" ? sourcesSettled.value : null;
  const federated =
    sources === null ? null : slugsServing(sources, surface.type).includes(source);

  // The entity read's own answer, kept whole: `null` means it did not succeed.
  const fetched: EntityPage | null =
    entitiesSettled.status === "fulfilled" ? entitiesSettled.value : null;

  // REAL ROWS ALWAYS WIN over the gate's verdict. `slugsServing` reads the map
  // platform-api gates on, so a successful read from a slug it says is
  // undeclared should not be reachable — but if the two ever disagree, the
  // dangerous direction is hiding records that exist behind "not switched on",
  // the same mistake as rendering a 503 as "no metrics". So the calm state
  // needs BOTH an undeclared slug and a read that did not come back.
  const notFederated = federated === false && fetched === null;

  const result: EntityPage = fetched ?? EMPTY_PAGE;
  // Every rejection, unfiltered. The refusal that `notFederated` explains is
  // discarded by not being READ: that branch renders the calm state below
  // without calling `entityState`, so this value never reaches the page.
  // Suppressing it here as well was tried and removed — no test could tell the
  // difference, which is the definition of a clause that is not doing work.
  const error: unknown =
    entitiesSettled.status === "rejected" ? entitiesSettled.reason : null;

  // From the product's own total, not `rows.length === limit` — see pagerLinks.
  const pager: PagerLinks = pagerLinks(
    basePath,
    resolved,
    pageNumber,
    result.data.length,
    result.pagination.total,
  );

  const typeLabel = entityTypeLabel(surface.type);

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title={typeLabel}
        description={`${label}'s ${surface.type} records, as ${label} reports them.`}
      />

      <EntityIndex
        descriptors={ENTITY_FILTERS}
        values={search ? ({ q: search } satisfies FilterValues) : {}}
        tableLabel={`${label} ${surface.type}`}
        recordHeading={typeLabel}
        page={result}
        pager={pager}
        state={
          notFederated
            ? notFederatedState(
                typeNotFederatedTitle(label, surface.type),
                typeNotFederatedMessage(label, surface.type),
              )
            : entityState({
                error,
                rows: result.data,
                filtered: search !== undefined,
                label,
                type: surface.type,
              })
        }
        emptyMessage={emptyMessage(label, surface.type)}
        scopeNote={SCOPE_NOTE}
        // `pageHref` rebuilds the canonical URL for the page being viewed:
        // every other param preserved, `page` re-added only above 1.
        reauthReturnTo={pageHref(basePath, resolved, pageNumber)}
      />
    </div>
  );
}
