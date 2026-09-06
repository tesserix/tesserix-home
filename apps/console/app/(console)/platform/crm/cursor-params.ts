/**
 * The URL param each CRM list pages by.
 *
 * A param each, not one shared `cursor`: Due and Drifting render on the same
 * page under one filter bar, so a single param would make paging one queue
 * also move — or, worse, resume — the other from a position that belongs to
 * its neighbour. The orderings are over different columns (`next_action_at`,
 * `COALESCE(last_contacted_at, created_at)`, `COALESCE(closed_at,
 * updated_at)`), so a cursor from one list is not merely off-by-a-page in
 * another; it is meaningless there. The Closed list is on a tab of its own so
 * it never shares a screen with the queues, but it does share a URL with
 * them: a tab link carries every other param across, this one included.
 *
 * Their own module, not constants in `page.tsx`, because both halves of the
 * surface need them: the server page reads and writes them, and the client
 * views — `queue-view.tsx` and `closed-view.tsx` — drop them on a filter
 * change, both through the one `ALL_CURSOR_PARAMS` below. Importing them from
 * `page.tsx` would drag a server module — `next/headers` and the repo along
 * with it — across the client boundary.
 */
export const DUE_CURSOR_PARAM = "dueCursor";
export const DRIFT_CURSOR_PARAM = "driftCursor";
export const CLOSED_CURSOR_PARAM = "closedCursor";

/**
 * EVERY cursor on the CRM surface, and the set a filter mutation drops.
 *
 * One list, imported by both views, because the rule is a property of the
 * SURFACE and not of either tab. Work and Closed share one filter bar, and
 * `tabHref` deliberately carries every query param across a tab switch — so
 * narrowing a filter on one tab invalidates the position the OTHER tab would
 * resume from just as surely as its own.
 *
 * Before #567 each view dropped only the cursors it rendered: `queue-view`
 * took `dueCursor`/`driftCursor`, `closed-view` took `closedCursor`. Changing
 * a filter on Work therefore left a live `closedCursor` in the URL (and vice
 * versa), and switching tabs landed on a keyset position the new filter never
 * produced. The result is a filtered-empty page — well-formed, not an error,
 * and on screen indistinguishable from "nothing matches".
 *
 * WHY THE WHOLE SET AND NOT JUST THE CURRENT TAB'S. That was the shape the
 * old `closed-view` comment argued for, on the grounds that the queue cursors
 * "belong to the tab the operator left". But by its own stated principle — a
 * narrowed filter invalidates the position it names — a SHARED filter
 * invalidates all three. Fixing one view and not the other would only move
 * the asymmetry, which is why #567 says half of this is worse than neither.
 *
 * A module constant, not an array literal at each call site, so the hook's
 * memoised `push` keeps a stable identity.
 */
export const ALL_CURSOR_PARAMS = [
  DUE_CURSOR_PARAM,
  DRIFT_CURSOR_PARAM,
  CLOSED_CURSOR_PARAM,
] as const;
