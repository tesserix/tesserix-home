import { ONBOARDING_SESSIONS_PATH, type OnboardingSearchParams } from "../source-choice";

/**
 * Paging for the onboarding session queue.
 *
 * # Its own module, not Kora's `entity-page.ts`
 *
 * That one is close but wrong here in the one way a pager must not be wrong:
 * its `pagerLinks` computes the preceding count from `ENTITIES_LIMIT`, a
 * console-side constant. This queue's page size is whatever mark8ly APPLIED,
 * echoed back through `meta.limit`, and using a constant instead would make
 * every range after the first wrong by the difference the moment the product
 * narrowed a page — silently, and in the direction that makes an operator
 * believe they have seen rows they have not.
 *
 * # Nothing here imports `lib/platform-api`
 *
 * The view is a client component and imports this module for its types. A
 * value import reaching `platform-api.ts` would rope `pg` into the browser
 * bundle (see `lib/platform-api-error.ts`'s header), so the fallback page size
 * is PASSED IN by the server page rather than read from there.
 */

/**
 * Read the 1-based page from the URL.
 *
 * Anything that is not a positive integer is treated as page 1 rather than
 * refused — deliberately gentler than the platform API, which 400s the same
 * input: an operator who hand-edits `?page=abc` should see the first page,
 * whereas a caller the API can see is a link-builder with a bug.
 *
 * Repeated params are ignored: the surface shows one page, and honouring the
 * first of two would page somewhere the URL does not say.
 */
export function readPage(searchParams: OnboardingSearchParams): number {
  const raw = searchParams.page;
  if (typeof raw !== "string") return 1;
  const page = Number.parseInt(raw, 10);
  if (!Number.isInteger(page) || page < 1) return 1;
  return page;
}

/**
 * The href for another page of the same queue.
 *
 * Every OTHER param is preserved — the source and the filters especially. An
 * operator on page 2 of a filtered queue who clicks Next must stay in that
 * filter; dropping `status` would move them to page 3 of everything, which
 * looks like the filter broke.
 */
export function pageHref(searchParams: OnboardingSearchParams, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "page") continue;
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
  }
  // Page 1 carries no param, so the first page has ONE canonical URL rather
  // than two that render identically — which matters for a link an operator
  // may share or paste into a ticket.
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${ONBOARDING_SESSIONS_PATH}?${query}` : ONBOARDING_SESSIONS_PATH;
}

export interface SessionsPager {
  /** Matching rows sorting ahead of this page; 0 on the first. */
  readonly precedingCount: number;
  readonly nextHref: string | null;
  readonly previousHref: string | null;
}

/**
 * The pager's position and its two links.
 *
 * `appliedLimit` is mark8ly's echo of the page size it ACTUALLY used, which is
 * not always the one asked for — platform-api clamps to 200 and the product
 * may narrow further. That echo exists precisely so a client can stop
 * inferring the size from a short page, so it is what the range is computed
 * from. `requestedLimit` is the fallback for an absent echo (`meta.limit` is
 * `omitempty`, so a zero vanishes on the wire); on page 1 it is multiplied by
 * zero and cannot matter, and page 1 is the only page reachable without the
 * pager having already worked.
 *
 * `nextHref` comes from `total`, not from `rows.length === limit` — the
 * classic off-by-one, where a result set that is an exact multiple of the page
 * size offers one empty page past the end.
 */
export function sessionsPager(
  searchParams: OnboardingSearchParams,
  page: number,
  rowsOnPage: number,
  total: number,
  appliedLimit: number | null,
  requestedLimit: number,
): SessionsPager {
  const precedingCount = (page - 1) * (appliedLimit ?? requestedLimit);
  return {
    precedingCount,
    nextHref: precedingCount + rowsOnPage < total ? pageHref(searchParams, page + 1) : null,
    previousHref: page > 1 ? pageHref(searchParams, page - 1) : null,
  };
}
