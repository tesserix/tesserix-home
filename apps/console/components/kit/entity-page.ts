import { ENTITIES_LIMIT } from "@/lib/platform-api";

/**
 * Paging shared by every §3.4 index surface.
 *
 * Extracted rather than written twice: Kora's food index and user directory,
 * its AI metrics list and the generic `[product]/[entity]` index all page the
 * same endpoint with the same bound, and the one thing a pager must never get
 * wrong — an off-by-one that offers a next page which is empty — should have a
 * single definition and a single set of tests.
 *
 * It lived under `kora/` while Kora's three pages were its only callers. It
 * moved here unchanged when the generic entity index became a fourth: a shared
 * util under one product's rail invites the next caller to copy it instead.
 *
 * The CRM organisations list is a fifth caller and NOT a §3.4 surface: it pages
 * the console's own store rather than the platform API, and at its own page
 * size — which is why `limit` below is a parameter rather than the constant.
 */

export type IndexSearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the 1-based page from the URL.
 *
 * Anything that is not a positive integer is treated as page 1 rather than
 * refused. That is deliberately gentler than the platform API, which 400s the
 * same input: an operator who hand-edits `?page=abc` should see the first page,
 * not an error, whereas a caller the API can see is a link-builder with a bug.
 *
 * Repeated params are ignored for the reason the filters give: the surface
 * takes one value per key, so honouring the first would page somewhere the
 * URL does not say.
 */
export function readPage(searchParams: IndexSearchParams): number {
  const raw = searchParams.page;
  if (typeof raw !== "string") return 1;
  const page = Number.parseInt(raw, 10);
  if (!Number.isInteger(page) || page < 1) return 1;
  return page;
}

/**
 * The href for another page of the same result set.
 *
 * Every OTHER param is preserved — the search especially. An operator on page
 * 2 of a search who clicks Next must stay in that search; dropping `q` would
 * silently move them to page 3 of everything, which looks like the search
 * broke.
 */
export function pageHref(
  basePath: string,
  searchParams: IndexSearchParams,
  page: number,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "page") continue;
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
  }
  // Page 1 carries no param, so the first page has ONE canonical URL rather
  // than two that render identically — which matters for a link an operator
  // may share or bookmark.
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export interface PagerLinks {
  /** Rows sorting ahead of this page; 0 on the first. */
  readonly precedingCount: number;
  readonly nextHref: string | null;
  readonly previousHref: string | null;
}

/**
 * The pager's position and its two links.
 *
 * `nextHref` is null when this page reaches the total, so the last page does
 * not offer a link to an empty one — a dead "Next" promises a page that is not
 * there, and an operator who clicks it concludes the surface is broken rather
 * than finished.
 *
 * It is computed from `total` rather than from `rows.length === limit`, which
 * is the classic off-by-one: a result set that is an exact multiple of the
 * page size would offer one empty page past the end.
 *
 * `limit` defaults to `ENTITIES_LIMIT` because the four §3.4 index surfaces
 * that were this function's only callers all page the platform API at that
 * bound. It became a parameter for the CRM organisations list, which pages its
 * own store 100 rows at a time: with the constant assumed, its page 3 of 259
 * counts 100 rows ahead instead of 200 and offers a Next to an empty page.
 * (`onboarding/sessions/pager.ts` forked over the same mismatch, but for a
 * second reason a parameter here does not solve: its view is a client
 * component that imports the module for its types, so nothing in it may reach
 * `lib/platform-api` at all.)
 */
export function pagerLinks(
  basePath: string,
  searchParams: IndexSearchParams,
  page: number,
  rowsOnPage: number,
  total: number,
  limit: number = ENTITIES_LIMIT,
): PagerLinks {
  const precedingCount = (page - 1) * limit;
  const hasNext = precedingCount + rowsOnPage < total;
  return {
    precedingCount,
    nextHref: hasNext ? pageHref(basePath, searchParams, page + 1) : null,
    previousHref: page > 1 ? pageHref(basePath, searchParams, page - 1) : null,
  };
}
