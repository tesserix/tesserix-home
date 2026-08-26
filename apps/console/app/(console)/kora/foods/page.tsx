import { ConsolePageHeader } from "@/components/kit/page-header";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// Imported from `surface-state` and NOT from `states`: this is a server
// component, and `states.tsx` carries a load-bearing `"use client"` that turns
// every export into a client reference. Calling `resolveState` through that
// reference throws at runtime while tsc, `next build` and jsdom tests all
// pass — it 500'd the dashboard once.
import {
  NOT_IMPLEMENTED,
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchProductEntities } from "@/lib/platform-api";
import { pagerLinks, readPage, type PagerLinks } from "../entity-page";
import type { EntityPage } from "@/lib/entities";
import { FoodIndex } from "./food-index";

/**
 * Kora's food index — the console's FIRST product-rail page.
 *
 * Reads `GET /v1/entities/foods?source=kora`, which platform-api's entities
 * module federates from §3.4. Not the estate tenant directory's module: that
 * one fans out and merges because a tenant means the same thing everywhere,
 * whereas an entity type does not — `foods` is Kora's and nobody else's.
 *
 * # Why this is a product-rail page and the inbox is not
 *
 * §8.5's test: can two products' rows sit in one table without a column
 * meaning something different in each? For inbox items, yes — so the inbox is
 * estate-wide. For foods, no: another product's `foods` would be a different
 * catalogue with different columns. The question presupposes the product, so
 * it belongs on the product's rail.
 */

/**
 * Browse and search, both — which is the contract's shape, not a local choice.
 *
 * Kora refused a query shorter than two characters and refused an ABSENT one
 * outright until kora#480, so an index page was impossible: opening it yielded
 * a 400. §3.4 now records browse-and-search estate-wide (mark8ly always
 * behaved this way), so an empty search is a legitimate "everything, paged".
 *
 * A SEARCH box rather than a select, for the reason the tenant directory gives
 * about status: the values are the product's and enumerating them console-side
 * would be a second vocabulary that drifts from the first.
 */
export const FOOD_FILTERS: FilterDescriptor[] = [
  { key: "q", label: "Search foods", type: "search" },
];

export type FoodSearchParams = Record<string, string | string[] | undefined>;

/** Where this surface lives, for the pager's hrefs. */
export const FOOD_PATH = "/kora/foods";

export interface FoodFilters {
  q?: string;
}

/**
 * Read the filters out of the URL.
 *
 * A query string is untrusted input. `q` is free text by design, so there is
 * nothing to validate it against — it is trimmed, and a blank one is dropped
 * rather than sent, because a blank `q` is a browse and sending `q=` would
 * filter on the empty string.
 *
 * Repeated params arrive as an array and are ignored: the endpoint takes one
 * value per key, so honouring the first would apply a filter the bar cannot
 * display.
 */
export function readFoodFilters(searchParams: FoodSearchParams): FoodFilters {
  const q = searchParams.q;
  if (typeof q === "string" && q.trim() !== "") return { q: q.trim() };
  return {};
}

export function toFilterValues(filters: FoodFilters): FilterValues {
  return filters.q ? { q: filters.q } : {};
}

/** Copy for the `empty` state — no rows, and no search narrowing them. */
export const FOOD_EMPTY_MESSAGE = "Kora's food index is empty.";

/**
 * The honest limit of what is on screen.
 *
 * Kora reports over six thousand foods and the page asks for a bounded slice.
 * No number is quoted: the bound is `platform-api.ts`'s to choose, and a
 * transcribed constant here is the copy that goes stale.
 */
export const FOOD_SCOPE_NOTE = "Search to narrow the index, or page through it.";

/**
 * Copy for the 501, which is NOT an error and must not read as one.
 *
 * A 501 here means `PLATFORM_API_ORIGIN` is unset or no product is federated.
 * Neither is a fault. The kit's default 501 copy points at
 * `docs/observability-park.md`, which is right for a parked metrics plane and
 * wrong here.
 */
export const FOOD_UNAVAILABLE_TITLE = "Kora's food index is not switched on";
export const FOOD_UNAVAILABLE_MESSAGE =
  "The console is not configured to read Kora's records yet. Nothing is broken " +
  "and there is nothing to retry — this surface turns on when the platform API " +
  "is configured with Kora as a source.";

export function foodReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: { title: FOOD_UNAVAILABLE_TITLE, message: FOOD_UNAVAILABLE_MESSAGE },
  };
}

export interface IndexStateInput {
  readonly error: unknown;
  readonly rows: readonly unknown[];
  readonly filtered: boolean;
}

/**
 * Which state the index is in.
 *
 * `filtered` is real here, unlike on the inbox: this surface HAS a search, so
 * "no results — clear the search" is a true and useful thing to say when a
 * query matched nothing, and a different thing from an empty catalogue.
 */
export function indexState(input: IndexStateInput): SurfaceState {
  return resolveState({
    isLoading: false,
    error: foodReadError(input.error),
    rows: input.rows,
    filtered: input.filtered,
  });
}

/** The operator's exact URL as a relative path, so signing in again returns
 *  them where they were. Same shape `middleware.ts`'s `unauthorized` builds. */
export function currentPath(searchParams: FoodSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
  }
  const query = params.toString();
  return query ? `/kora/foods?${query}` : "/kora/foods";
}

const EMPTY_PAGE: EntityPage = { data: [], pagination: { page: 1, limit: 0, total: 0 } };

export default async function KoraFoodIndex({
  searchParams,
}: {
  searchParams: Promise<FoodSearchParams>;
}) {
  const resolved = await searchParams;
  const filters = readFoodFilters(resolved);
  const page = readPage(resolved);

  // Caught rather than allowed to reject: a 501 and a genuine failure are both
  // states this page renders, and an uncaught rejection would show the route
  // error boundary instead.
  let result: EntityPage = EMPTY_PAGE;
  let error: unknown = null;
  try {
    result = await fetchProductEntities("kora", "foods", filters.q, page);
  } catch (caught: unknown) {
    error = caught;
  }

  // Computed AFTER the read, from the product's own total — a pager derived
  // from `rows.length === limit` offers one empty page past the end whenever
  // the result set is an exact multiple of the page size.
  const pager: PagerLinks = pagerLinks(FOOD_PATH, resolved, page, result.data.length, result.pagination.total);

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Food index"
        description="Every food Kora can resolve, with the newest additions first."
      />

      <FoodIndex
        descriptors={FOOD_FILTERS}
        values={toFilterValues(filters)}
        page={result}
        pager={pager}
        state={indexState({
          error,
          rows: result.data,
          filtered: filters.q !== undefined,
        })}
        emptyMessage={FOOD_EMPTY_MESSAGE}
        scopeNote={FOOD_SCOPE_NOTE}
        reauthReturnTo={currentPath(resolved)}
      />
    </div>
  );
}
