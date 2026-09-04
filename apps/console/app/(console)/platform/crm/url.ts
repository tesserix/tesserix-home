/**
 * The CRM surface's URL: what this page reads out of a query string, and how
 * it builds the links that put values back into one.
 *
 * Its own module because three server modules now need it — `page.tsx` and
 * the two tabs that page and filter (`closed-tab.tsx`, and `page.tsx`'s own
 * Work tab) — and having the tabs import it from `page.tsx`, which imports
 * them, would be an import cycle. Browser-safe by construction: nothing here
 * touches the database, `next/headers` or a token.
 */

export type QueueSearchParams = Record<string, string | string[] | undefined>;

export type CrmTab = "work" | "handoff" | "closed";

/** Which tab `?tab=` selects — anything else (including nothing) is "work",
 *  the surface's default. Same "unrecognised input reads as unfiltered"
 *  contract `readQueueFilters` applies to `stage`/`product`. */
export function readTab(searchParams: QueueSearchParams): CrmTab {
  if (searchParams.tab === "handoff") return "handoff";
  if (searchParams.tab === "closed") return "closed";
  return "work";
}

/** A list's cursor as the repo wants it: the raw string, or `undefined` for
 *  "start at the beginning". A repeated param arrives as an array and is
 *  dropped, the same way `readQueueFilters` drops a repeated filter. An
 *  otherwise malformed value is NOT screened here — the repo validates and
 *  rejects it, and the tab surfaces that rejection as the list's own error
 *  state (see `renderWorkTab`'s `Promise.allSettled` comment). */
export function readCursor(
  searchParams: QueueSearchParams,
  key: string,
): string | undefined {
  const raw = searchParams[key];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * One list's page link: every param already on the URL, with only that
 * list's own cursor replaced.
 *
 * Copied rather than enumerated, for the reason `buildCursorHref`
 * (`organisations/page.tsx`) records — this page carries five filter params
 * plus `tab` plus the other lists' cursors, and a builder naming the ones it
 * knows about drops whichever it forgot the moment an operator pages. The
 * other cursors are part of that: paging Due must leave Drifting on the page
 * the operator left it on, backwards as well as forwards.
 *
 * One builder serves every control because a cursor carries the direction it
 * points in (see `lib/db/keyset-cursor.ts`), so a link never needs a second
 * param that could go missing.
 */
function buildQueueCursorHref(
  searchParams: QueueSearchParams,
  cursorParam: string,
  cursor: string | null,
): string | null {
  if (!cursor) return null;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === cursorParam) continue;
    if (typeof value === "string") {
      params.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    }
  }
  params.set(cursorParam, cursor);

  return `/platform/crm?${params.toString()}`;
}

/** One list's next-page link, or null when it is on its last page. */
export function buildQueueNextHref(
  searchParams: QueueSearchParams,
  cursorParam: string,
  nextCursor: string | null,
): string | null {
  return buildQueueCursorHref(searchParams, cursorParam, nextCursor);
}

/** One list's previous-page link, or null when it is on its first page. */
export function buildQueuePreviousHref(
  searchParams: QueueSearchParams,
  cursorParam: string,
  previousCursor: string | null,
): string | null {
  return buildQueueCursorHref(searchParams, cursorParam, previousCursor);
}

/**
 * The operator's exact URL as a relative path — every param the browser had,
 * not only the ones this page recognises as filters or a tab — so signing in
 * again returns them exactly where they were, five filters and a page cursor
 * included. `middleware.ts`'s `unauthorized` builds the same shape
 * (`${pathname}${search}`) for the identical reason.
 *
 * Copies every entry rather than naming the params this page knows about,
 * for the same reason `buildQueueCursorHref` does: a builder that names them
 * drops whichever one it forgot the moment this page grows another filter.
 */
export function currentPath(searchParams: QueueSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      params.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    }
  }
  const qs = params.toString();
  return qs ? `/platform/crm?${qs}` : "/platform/crm";
}

/**
 * A tab's `href`, preserving every other search param (the Work tab's own
 * product/stage/owner filters survive a round trip through Handoff and
 * back) and setting/clearing only `tab`.
 *
 * Real navigation, not a client-side tab switch: this page's tabs do not
 * cost the same to render. Handoff's is up to `HANDOFF_LIMIT` outbound calls
 * to apps/web; Work's is two queue reads and Closed's is one. A
 * `SurfaceTabs`-style "render both panels once, switch instantly" (as
 * `tickets/page.tsx` does for its Queue/Analytics split) would mean loading
 * `/platform/crm` on Work always pays for the Handoff fan-out too, whether
 * or not anyone ever clicks that tab — every one of those calls a guaranteed
 * `unknown` today, and a genuine 8s stall on the WORK queue the day apps/web
 * is slow to answer rather than fast to 404. Only the active tab's data is
 * ever read.
 */
export function tabHref(searchParams: QueueSearchParams, tab: CrmTab): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || typeof value !== "string" || value === "") continue;
    params.set(key, value);
  }
  // "work" is the default `readTab` falls back to, so it is spelled by the
  // absence of the param rather than by a value.
  if (tab !== "work") {
    params.set("tab", tab);
  }
  const qs = params.toString();
  return qs ? `/platform/crm?${qs}` : "/platform/crm";
}
