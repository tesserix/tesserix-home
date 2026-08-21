import type { QueueFilter } from "@/lib/db/crm-repo";
import { UNASSIGNED_PRODUCT, UNKNOWN_COUNTRY, UNKNOWN_FOLLOWERS } from "@/lib/db/crm-filters";

/**
 * The console and the platform API spell "has no value" differently, and this
 * is the only place that knows it.
 *
 * The console puts a SENTINEL IN THE VALUE — `product=__unassigned__` — because
 * its filter state has to survive a round trip through a URL query string that
 * a person can edit. The platform API takes a SEPARATE BOOLEAN — the
 * `<axis>_unset=true` parameters listed in `handler.go`'s `filterParameters` —
 * and answers 422 if an axis arrives with both, naming both keys in `details`.
 *
 * Neither is wrong; they are two encodings of one tri-state. Translating in one
 * function, tested per axis, is the alternative to three call sites each
 * getting it right. Getting it wrong does not raise an error — it drops the
 * filter and returns the whole queue, which looks like a filter that matched a
 * lot. That is the failure #302 exists to refuse, arriving from the client side
 * instead.
 */
const UNSET_SENTINELS: ReadonlyMap<keyof QueueFilter, string> = new Map([
  ["product", UNASSIGNED_PRODUCT],
  ["country", UNKNOWN_COUNTRY],
  ["followers", UNKNOWN_FOLLOWERS],
]);

/** Axes whose value is passed through untouched — no unset spelling exists. */
const PLAIN_AXES: readonly (keyof QueueFilter)[] = ["stage", "owner"];

export function queueQuery(
  filter: QueueFilter,
  limit: number,
  cursor?: string,
): URLSearchParams {
  const query = new URLSearchParams();

  for (const [axis, sentinel] of UNSET_SENTINELS) {
    const value = filter[axis];
    if (!value) continue;
    if (value === sentinel) {
      // The twin, never both: sending both is a 422 naming both keys.
      query.set(`${axis}_unset`, "true");
    } else {
      query.set(axis, value);
    }
  }

  for (const axis of PLAIN_AXES) {
    const value = filter[axis];
    if (value) query.set(axis, value);
  }

  query.set("limit", String(limit));
  if (cursor) query.set("cursor", cursor);
  return query;
}
