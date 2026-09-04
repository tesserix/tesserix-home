/**
 * The opaque keyset cursor every paged console surface travels on, plus the
 * two row-trimming helpers that turn a `limit + 1` fetch into a page.
 *
 * Its own module rather than a private helper in `crm-repo.ts` because two
 * unrelated concerns need it: the repositories that mint and read cursors,
 * and `lib/db-read-error.ts`, which has to recognise a rejected cursor to
 * tell an operator the LINK is wrong rather than inviting a retry that can
 * never work. A repository import from the error path would drag the whole
 * CRM repo — and `pg` with it — into that module.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which way a cursor points, relative to the row it anchors on, in the
 * surface's own DISPLAY order.
 *
 * "after"/"before" and not "asc"/"desc", "next"/"prev" or a boolean: this
 * codec cannot know how its caller sorts. `listOrganisations` and
 * `closedOpportunities` read newest first while the two work queues read
 * oldest first, so a cursor that claimed a sort order would be lying to one
 * of them. What a cursor honestly knows is that
 * the page being asked for lies after — or before — the row it names, and
 * each caller resolves that against the order it alone declares.
 */
export type CursorDirection = "after" | "before";

/** A keyset position: one timestamp, the id that breaks its ties, and the
 *  side of that tuple the requested page lies on. */
export interface KeysetCursor {
  timestamp: string;
  id: string;
  direction: CursorDirection;
}

/**
 * A cursor that could not be read. Its own class so the error path can tell
 * this apart from a database failure: a malformed cursor is a bad link, not
 * a flaky read, and the two want opposite advice.
 *
 * The `malformedCursor` marker is carried alongside the class for the reason
 * `toSurfaceError` records about `instanceof` — an identity check across a
 * bundler boundary can quietly fail even when the class is right, and the
 * consequence here would be an operator told to retry a link that can never
 * load.
 */
export class MalformedCursorError extends Error {
  readonly malformedCursor = true;

  constructor(label: string) {
    super(`${label}: malformed cursor`);
    this.name = "MalformedCursorError";
  }
}

/**
 * True when a caught value is (or wraps) a rejected cursor.
 *
 * The `cause` chain is walked for the same reason `isUndefinedTable` walks
 * it: a caller may wrap the rejection to add context, and the classification
 * must survive that wrapping or the page falls back to the generic failure,
 * which is the state this exists to avoid.
 */
export function isMalformedCursorError(caught: unknown): boolean {
  for (let value = caught, depth = 0; value !== null && value !== undefined && depth < 4; depth++) {
    if (typeof value !== "object") return false;
    if (value instanceof MalformedCursorError) return true;
    if ((value as { malformedCursor?: unknown }).malformedCursor === true) return true;
    value = (value as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Cursor = base64 of `<direction>|<iso-timestamp>|<uuid>`. Encoded (not a
 * raw tuple the caller could construct) so a surface isn't tempted to build
 * one by hand from URL params it half-trusts.
 *
 * The direction lives IN the cursor rather than beside it as a second URL
 * param because a cursor is only ever handled as one opaque string: copied
 * into a link, shared, bookmarked, reloaded. A separate `?direction=` is one
 * copy-paste away from being lost, and a cursor whose direction went missing
 * does not fail — it renders the page on the wrong side of the anchor row
 * and says nothing.
 *
 * Shared by the browse surface and both queues, but only this far. What is
 * genuinely common is the *encoding* and its validation, and that much says
 * nothing about which way a surface sorts, so sharing it cannot make either
 * surface lie about its order.
 *
 * The SQL is deliberately NOT shared, and the split is by TABLE and paging
 * regime rather than by direction: `listOrganisations` pages `crm_organisations`
 * under a caller-chosen sort key, while `queuePage` pages `crm_opportunities`
 * under a sort key each list fixes for itself. `queuePage` does take a
 * direction — `closedOpportunities` reads descending and both work queues
 * ascending — but it is a REQUIRED argument, so every call site states its
 * own order where a reader is already looking. That is the answer to the
 * objection an optional one would deserve: a reader who cannot see the
 * direction cannot tell what a page means.
 */
export function encodeKeysetCursor(
  timestamp: string,
  id: string,
  direction: CursorDirection,
): string {
  return Buffer.from(`${direction}|${timestamp}|${id}`, "utf-8").toString("base64");
}

/**
 * Decode and validate a cursor. This arrives off a URL, so a malformed or
 * unparseable value is rejected outright — never coerced into a query (which
 * is how a garbage timestamp would end up bound straight into a keyset
 * predicate), and never silently degraded to page one (which would show the
 * operator something other than the page the URL asked for, reporting
 * success while withholding the truth).
 *
 * An unrecognised direction is rejected on the same terms, including the
 * two-field shape this codec used before it carried one: defaulting a
 * missing direction to "after" would take a link built to page backwards and
 * quietly serve the page ahead instead.
 *
 * `Buffer.from(cursor, "base64")` itself never throws — invalid base64 is
 * decoded leniently, with invalid characters dropped, not rejected. The
 * rejection this function promises comes entirely from the field/date/UUID
 * checks below, which is why there is no try/catch around the decode.
 */
export function decodeKeysetCursor(cursor: string, label: string): KeysetCursor {
  const fields = Buffer.from(cursor, "base64").toString("utf-8").split("|");
  if (fields.length !== 3) {
    throw new MalformedCursorError(label);
  }
  const [direction, timestamp, id] = fields;
  if (direction !== "after" && direction !== "before") {
    throw new MalformedCursorError(label);
  }
  if (Number.isNaN(Date.parse(timestamp)) || !UUID_RE.test(id)) {
    throw new MalformedCursorError(label);
  }
  return { timestamp, id, direction };
}

/** A `limit + 1` fetch, resolved into the page and the proof of another one. */
export interface TrimmedPage<T> {
  rows: readonly T[];
  /** True when the fetch returned its proof row: another page exists in the
   *  direction this one was fetched. */
  hasMore: boolean;
}

/**
 * Resolve a forward `limit + 1` fetch into a page.
 *
 * A forward fetch is ordered the way the surface displays, so the rows
 * arrive in display order and the extra row is the first of the NEXT page.
 */
export function trimForwardPage<T>(rawRows: readonly T[], limit: number): TrimmedPage<T> {
  const hasMore = rawRows.length > limit;
  return { rows: hasMore ? rawRows.slice(0, limit) : rawRows, hasMore };
}

/**
 * Resolve a backward `limit + 1` fetch into a page, in display order.
 *
 * A backward fetch flips the ORDER BY, so SQL returns the row NEAREST the
 * anchor first — that is, the page's LAST row first, with every row after it
 * running backwards. Two things follow, and both are easy to get wrong
 * because a small fixture hides them:
 *
 * - the proof row is at the END of the fetch (it is the furthest from the
 *   anchor, and belongs to the page before this one), so the page is the
 *   first `limit` rows exactly as in the forward case;
 * - the page must then be re-reversed before it is returned. Skipping that
 *   renders the page upside down while its counts, its range and both its
 *   cursors all remain correct — a defect that shows up nowhere except in
 *   the order of the rows themselves.
 *
 * `slice().reverse()`, not `reverse()`: the array handed in is the driver's
 * result set, and `reverse` is in place.
 */
export function trimBackwardPage<T>(rawRows: readonly T[], limit: number): TrimmedPage<T> {
  const hasMore = rawRows.length > limit;
  const page = hasMore ? rawRows.slice(0, limit) : rawRows;
  return { rows: page.slice().reverse(), hasMore };
}
