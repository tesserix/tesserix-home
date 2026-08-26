import { ConsolePageHeader } from "@/components/kit/page-header";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// From `surface-state`, NOT `states`: this is a server component and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass.
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
import { UserDirectory } from "./user-directory";

/**
 * Kora's users — the second product-rail page, reading `GET
 * /v1/entities/users?source=kora`.
 *
 * # Read-only, deliberately
 *
 * Kora's admin API already serves `DELETE /v1/admin/users/:id`, and this page
 * does not offer it. That is a decision, not an omission:
 *
 *   - §8.3 requires confirmation semantics on anything irreversible — the
 *     request carries the resource's identifying state and the product rejects
 *     a mismatch. Not a modal; a payload the product can refuse.
 *   - §8.4 requires the capability be named per route. Every Kora route is
 *     `platform` today, and deleting a person's account is not the same
 *     authority as listing them.
 *   - §8.8 would want reason codes, which Kora does not publish for users.
 *
 * The estate has precedent for pausing exactly here rather than inventing an
 * answer: mark8ly#288 (tenant purge) was deliberately not built because it
 * should require `platform` AND `hard-delete`, and would be the estate's first
 * route gated on a verb capability. Kora user deletion is the same decision,
 * and both should land on one answer rather than two different ones.
 */

/** Browse and search, both — the contract's shape since tesserix/kora#480.
 *  A search box rather than a select: the values are the product's, and
 *  enumerating them console-side is a second vocabulary that drifts. */
export const USER_FILTERS: FilterDescriptor[] = [
  { key: "q", label: "Search users", type: "search" },
];

export type UserSearchParams = Record<string, string | string[] | undefined>;

/** Where this surface lives, for the pager's hrefs. */
export const USER_PATH = "/kora/users";

export interface UserFilters {
  q?: string;
}

/**
 * Read the filters out of the URL.
 *
 * A blank `q` is dropped rather than sent: a blank query is a BROWSE, and
 * sending `q=` would filter on the empty string on a product that treats the
 * param as present. Repeated params are ignored — the endpoint takes one value
 * per key, so honouring the first would apply a filter the bar cannot show.
 */
export function readUserFilters(searchParams: UserSearchParams): UserFilters {
  const q = searchParams.q;
  if (typeof q === "string" && q.trim() !== "") return { q: q.trim() };
  return {};
}

export function toFilterValues(filters: UserFilters): FilterValues {
  return filters.q ? { q: filters.q } : {};
}

export const USER_EMPTY_MESSAGE = "Kora has no users yet.";

export const USER_SCOPE_NOTE = "Search to narrow the directory, or page through it.";

/**
 * Copy for the 501, which is NOT an error.
 *
 * The kit's default points at `docs/observability-park.md` — right for a
 * parked metrics plane, wrong here, where the answer is a config value.
 */
export const USER_UNAVAILABLE_TITLE = "Kora's user directory is not switched on";
export const USER_UNAVAILABLE_MESSAGE =
  "The console is not configured to read Kora's records yet. Nothing is broken " +
  "and there is nothing to retry — this surface turns on when the platform API " +
  "is configured with Kora as a source.";

export function userReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: { title: USER_UNAVAILABLE_TITLE, message: USER_UNAVAILABLE_MESSAGE },
  };
}

export interface DirectoryStateInput {
  readonly error: unknown;
  readonly rows: readonly unknown[];
  readonly filtered: boolean;
}

/** `filtered` is real here: this surface has a search, so "no results — clear
 *  the search" is true and useful, and a different thing from no users. */
export function directoryState(input: DirectoryStateInput): SurfaceState {
  return resolveState({
    isLoading: false,
    error: userReadError(input.error),
    rows: input.rows,
    filtered: input.filtered,
  });
}

export function currentPath(searchParams: UserSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
  }
  const query = params.toString();
  return query ? `/kora/users?${query}` : "/kora/users";
}

const EMPTY_PAGE: EntityPage = { data: [], pagination: { page: 1, limit: 0, total: 0 } };

export default async function KoraUsers({
  searchParams,
}: {
  searchParams: Promise<UserSearchParams>;
}) {
  const resolved = await searchParams;
  const filters = readUserFilters(resolved);
  const pageNumber = readPage(resolved);

  // Caught rather than allowed to reject: a 501 and a genuine failure are both
  // states this page renders, and an uncaught rejection would show the route
  // error boundary instead.
  let result: EntityPage = EMPTY_PAGE;
  let error: unknown = null;
  try {
    result = await fetchProductEntities("kora", "users", filters.q, pageNumber);
  } catch (caught: unknown) {
    error = caught;
  }

  // From the product's own total, not `rows.length === limit` — see pagerLinks.
  const pager: PagerLinks = pagerLinks(USER_PATH, resolved, pageNumber, result.data.length, result.pagination.total);

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Users"
        description="Everyone with a Kora account, newest first."
      />

      <UserDirectory
        descriptors={USER_FILTERS}
        values={toFilterValues(filters)}
        page={result}
        pager={pager}
        state={directoryState({ error, rows: result.data, filtered: filters.q !== undefined })}
        emptyMessage={USER_EMPTY_MESSAGE}
        scopeNote={USER_SCOPE_NOTE}
        reauthReturnTo={currentPath(resolved)}
      />
    </div>
  );
}
