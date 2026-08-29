/**
 * The two shapes platform-api sends paged results in, named so a test
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
 * Two producers, two shapes, confirmed against the Go source:
 *
 * | Module                          | Where pagination lives  |
 * |----------------------------------|--------------------------|
 * | `entities` (`service.go:137`, `json:"pagination"`)         | inside `data`, as `data.pagination` |
 * | `koraaimetrics` (`handler.go:86`, `httpx.WriteMeta`)       | in the envelope's `meta`, a sibling of `data` |
 *
 * `paginationInsideData` and `paginationInMeta` below are not a bare object
 * literal because a literal does not force the author to say which
 * convention they mean — these do, by name, at the call site. Neither
 * function does anything clever; the value is entirely in the name a
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
