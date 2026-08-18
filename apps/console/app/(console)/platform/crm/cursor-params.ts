/**
 * The URL param each CRM queue pages by.
 *
 * Two params, not one shared `cursor`: Due and Drifting render on the same
 * page under one filter bar, so a single param would make paging one queue
 * also move — or, worse, resume — the other from a position that belongs to
 * its neighbour. The two orderings are over different columns
 * (`next_action_at` vs `COALESCE(last_contacted_at, created_at)`), so a
 * cursor from one queue is not merely off-by-a-page in the other; it is
 * meaningless there.
 *
 * Their own module, not constants in `page.tsx`, because both halves of the
 * surface need them: the server page reads and writes them, and the client
 * `queue-view.tsx` drops them on a filter change. Importing them from
 * `page.tsx` would drag a server module — `next/headers` and the repo along
 * with it — across the client boundary.
 */
export const DUE_CURSOR_PARAM = "dueCursor";
export const DRIFT_CURSOR_PARAM = "driftCursor";
