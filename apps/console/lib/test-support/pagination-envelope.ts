/**
 * The three shapes platform-api sends paged results in, named so a test
 * fixture author must pick one on purpose rather than guessing which
 * convention a given producer uses.
 *
 * This exists because of a production bug (#421): `/kora/ai-metrics`'s
 * fixture (`kora-ai-metrics.test.ts`) asserted the `entities` module's shape
 * — `pagination` nested inside `data` — for an endpoint that actually uses
 * `koraaimetrics`'s shape — `total`/`limit` in the envelope's `meta`, a
 * sibling of `data`. The fixture and the parser agreed with EACH OTHER and
 * both disagreed with the producer, so every test passed while production
 * 500'd. A passing test named "refuses a response with no pagination" was
 * asserting production's own failure as correct behaviour.
 *
 * Three producers, three shapes, confirmed against the Go source:
 *
 * | Module                          | Where pagination lives  |
 * |----------------------------------|--------------------------|
 * | `entities` (`service.go:137`, `json:"pagination"`)         | inside `data`, as `data.pagination` |
 * | `koraaimetrics` (`handler.go:86`, `httpx.WriteMeta`)       | in the envelope's `meta`, a sibling of `data` |
 * | CRM queues (`GET /v1/crm/queues/*`, see `platform-api.ts`'s `unwrapEnvelope` doc comment) | cursor-based `meta`: `total`, `preceding_count`, `next_cursor`, `previous_cursor` — see `parseQueuePage` |
 *
 * All three are covered here — this file's own header claiming "two" while
 * the CRM queues' cursor shape stayed hand-written in `crm-queue-wire.test.ts`
 * and `platform-api.test.ts` was the exact defect this file exists to catch,
 * committed inside the file itself: a fixture author reading "two shapes"
 * would reasonably conclude `paginationInMeta` covers a CRM queue producer,
 * and it does not — that shape carries `preceding_count` and two cursors
 * `paginationInMeta`'s `MetaPaginationCounters` has no room for.
 *
 * `paginationInsideData`, `paginationInMeta` and `paginationCursorMeta` below
 * are not bare object literals because a literal does not force the author to
 * say which convention they mean — these do, by name, at the call site. None
 * of the three does anything clever; the value is entirely in the name a
 * fixture's author has to choose.
 */

/** The `entities` module's counters — `page`, `limit` and `total`, all three
 *  present because `data.pagination` is a self-contained object on the wire. */
export interface DataPaginationCounters {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
}

/** The `koraaimetrics` module's counters — `limit` and `total` only.
 *  Deliberately no `page`: `metaFrom` (`koraaimetrics/internal/handler/handler.go`)
 *  never emits one, since it is the one value the caller already supplied.
 *  See `parseKoraAiMetricsPagination`'s own doc comment. */
export interface MetaPaginationCounters {
  readonly limit: number;
  readonly total: number;
}

/**
 * The CRM queues' counters — cursor-based, not offset-based. `total` and
 * `preceding_count` place the page; `next_cursor`/`previous_cursor` are
 * opaque tokens for the next request, and are omittable because the queue
 * legitimately has no next or previous page. See `parseQueuePage`
 * (`lib/crm-queue-wire.ts`), which reads exactly this shape out of the
 * envelope's `meta` — structurally distinct from `MetaPaginationCounters`
 * above, which is why it is its own interface rather than an extension.
 */
export interface CursorPaginationMeta {
  readonly total: number;
  readonly preceding_count: number;
  readonly next_cursor?: string | null;
  readonly previous_cursor?: string | null;
}

/**
 * Nests `pagination` inside the given `data` object — the `entities`
 * module's convention (`GET /v1/entities/{type}`, and by extension every
 * `fetchProductEntities` caller: `/kora/foods`, `/kora/users`,
 * `/kora/ai-metrics`'s user-name join).
 */
export function paginationInsideData(
  data: Record<string, unknown>,
  pagination: DataPaginationCounters,
): Record<string, unknown> {
  return { ...data, pagination };
}

/**
 * The envelope's `meta` object — the `koraaimetrics` module's convention
 * (`GET /v1/kora/ai-metrics`, read via `platformRequestWithMeta`). Returned
 * as-is; the point of calling this rather than writing `{ total, limit }`
 * directly is the name at the call site, not any transformation.
 */
export function paginationInMeta(meta: MetaPaginationCounters): MetaPaginationCounters {
  return meta;
}

/**
 * The envelope's `meta` object in the CRM queues' cursor convention —
 * `GET /v1/crm/queues/*`, read via `platformRequestWithMeta` and parsed by
 * `parseQueuePage`. Returned as-is, like `paginationInMeta` above: the value
 * is the name at the call site, not any transformation.
 */
export function paginationCursorMeta(meta: CursorPaginationMeta): CursorPaginationMeta {
  return meta;
}
