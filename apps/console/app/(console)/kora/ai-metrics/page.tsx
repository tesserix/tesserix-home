import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass. See
// `platform/billing/catalog/page.tsx`'s identical comment.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import { fetchKoraAiMetricsPage, fetchProductEntities } from "@/lib/platform-api";
import { pagerLinks, readPage, type PagerLinks } from "@/components/kit/entity-page";
import type { EntityPagination, EntityRecord } from "@/lib/entities";
import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
import { AiMetricsView } from "./ai-metrics-view";

/**
 * `/kora/ai-metrics` — the full surface behind the `/kora` overview's three
 * AI-resolution tiles. Reads the same `GET /v1/kora/ai-metrics` federation
 * part 1 added, this time paged for the per-user table and modelling
 * everything the endpoint returns rather than only the three numbers a stat
 * tile can show.
 *
 * # TWO independent reads
 *
 * `fetchKoraAiMetricsPage` (the metrics, decoded twice by `kora-ai-metrics.ts`
 * for `data` and `meta` — see that module) and `fetchProductEntities("kora",
 * "users")` (one page of kora users, joined against the metrics rows to show
 * a name instead of a raw id — see `buildUserDirectory`). `Promise.allSettled`,
 * not sequential `await`s: the join is a courtesy on top of the metrics
 * table, not a dependency of it, so a failed name lookup must not blank a
 * metrics table that loaded fine, and the two round trips should not pay for
 * each other's latency in series.
 *
 * # The name join is one extra read, not N
 *
 * There is no id-filtered entity lookup on `/v1/entities/users` — the
 * documented params are `source, q, limit, page`, and an unknown one is
 * refused. So this can only name users inside the ONE page of kora users
 * fetched here (`fetchProductEntities`'s own `ENTITIES_LIMIT` default, 50).
 * Kora is small today, but at scale some rows will still show a raw id, which
 * is why `AiMetricsView` renders the id rather than a placeholder when no
 * match is found: "outside the fetched page" and "does not exist" are
 * different facts, and only one of them is true here. The clean long-term fix
 * is Kora returning a label on `ai-metrics` itself — a different repo, out of
 * scope for this surface.
 *
 * **That "one page" is always entities page 1** — `fetchProductEntities`
 * below is called with no page argument, while the metrics read a few lines
 * later IS paged by `?page=`. The two are unrelated result sets (the entities
 * directory's page 1 and the metrics table's page N are not the same 50
 * users), so on metrics page 1 the join is likely to hit; on page 2 and
 * beyond it is increasingly likely to miss entirely, and most rows fall back
 * to a raw id. Safe — the raw id IS the honest answer — but it is the
 * practical limit of this feature, stated here rather than left for a reader
 * to discover by noticing every row on page 3 is a UUID. Fetching every user
 * to cover every metrics page is deliberately not the fix — see "Do not fetch
 * every user" in part 1's plan.
 *
 * # No window picker
 *
 * `/v1/kora/ai-metrics` accepts a caller-chosen `from`/`to`, but this surface
 * does not offer a picker — Kora's default window is stated as a datum
 * (`AiMetricsView`'s first line) rather than left implicit, and a picker is a
 * separate design question this task's plan leaves open. Nothing here reads
 * `from`/`to`.
 *
 * # The 501 is not an error
 *
 * A 501 here means this deployment does not federate Kora at all — the exact
 * fact `/kora`'s overview already renders as `instrumentation-unavailable`
 * rather than an error. This page reuses the SAME default copy the kit
 * supplies for that state, deliberately not overriding it with surface-
 * specific text: part 1 makes no such override either, and the two pages
 * describe the identical deployment fact.
 */

export type AiMetricsSearchParams = Record<string, string | string[] | undefined>;

/** Where this surface lives, for the pager's hrefs. */
export const AI_METRICS_PATH = "/kora/ai-metrics";

export interface AiMetricsStateInput {
  readonly error: unknown;
  readonly metrics: KoraAiMetrics | null;
}

/**
 * Which state the page is in.
 *
 * `rows` is `[metrics]` when the read succeeded, never `[]` — the same
 * reasoning the overview's `tileState` applies to its own AI tile: a window
 * with zero attempts and no users is still a real, ready answer ("we
 * measured, and there was nothing to measure"), not an empty surface. Only a
 * whole read that threw resolves to anything other than `ready`.
 */
export function aiMetricsState(input: AiMetricsStateInput): SurfaceState {
  return resolveState({
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.metrics ? [input.metrics] : [],
    filtered: false,
  });
}

/** The operator's exact URL as a relative path, so signing in again returns
 *  them to the same page. Same shape `kora/foods/page.tsx`'s `currentPath`
 *  builds. */
export function currentPath(searchParams: AiMetricsSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
  }
  const query = params.toString();
  return query ? `${AI_METRICS_PATH}?${query}` : AI_METRICS_PATH;
}

const EMPTY_PAGINATION: EntityPagination = { page: 1, limit: 0, total: 0 };

/**
 * One page of kora users, keyed by id, for `AiMetricsView` to look a user's
 * row up by the raw id `kora-ai-metrics.ts` carries. A `Map`, not a plain
 * object: entity ids are opaque strings from another product and must never
 * collide with `Object.prototype` keys (`"toString"`, `"constructor"`, ...).
 *
 * Built once per read rather than searched per row — the join this page does
 * is O(users on this page), not O(metrics rows × users on this page).
 */
export function buildUserDirectory(
  entities: readonly EntityRecord[],
): ReadonlyMap<string, EntityRecord> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

export default async function KoraAiMetricsPage({
  searchParams,
}: {
  searchParams: Promise<AiMetricsSearchParams>;
}) {
  const resolved = await searchParams;
  const page = readPage(resolved);

  // `allSettled`, not sequential `await`s — see the module doc comment's
  // "TWO independent reads" section. A failed name join must not blank a
  // metrics table that loaded fine, and vice versa.
  //
  // `fetchProductEntities` below takes NO page — it always reads entities
  // page 1, while `fetchKoraAiMetricsPage(page)` reads whichever metrics
  // page the operator is on. The join only ever matches against that one
  // fixed page of users, so it degrades on metrics page 2+ — see the module
  // doc comment's "one page" note.
  const [metricsResult, usersResult] = await Promise.allSettled([
    fetchKoraAiMetricsPage(page),
    fetchProductEntities("kora", "users"),
  ]);

  let metrics: KoraAiMetrics | null = null;
  let pagination: EntityPagination = EMPTY_PAGINATION;
  let error: unknown = null;
  if (metricsResult.status === "fulfilled") {
    metrics = metricsResult.value.metrics;
    pagination = metricsResult.value.pagination;
  } else {
    error = metricsResult.reason;
  }

  // Best-effort: an empty directory on a failed or rejected read is not an
  // error state of its own — `AiMetricsView` already renders "no match" as
  // the raw id, which is the correct rendering for both "the join read
  // failed" and "this id is outside the fetched page".
  const userDirectory = buildUserDirectory(
    usersResult.status === "fulfilled" ? usersResult.value.data : [],
  );

  // From the product's own total, not `rows.length === limit` — see
  // `pagerLinks`. `ENTITIES_LIMIT` (this pager's implicit page size) is 50,
  // matching this endpoint's own default `limit` — see `fetchKoraAiMetricsPage`.
  const pager: PagerLinks = pagerLinks(
    AI_METRICS_PATH,
    resolved,
    page,
    metrics ? metrics.users.length : 0,
    pagination.total,
  );

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="AI metrics"
        description="How Kora's AI resolves foods, and where it still needs a human."
      />

      <AiMetricsView
        metrics={metrics}
        pager={pager}
        pagination={pagination}
        state={aiMetricsState({ error, metrics })}
        reauthReturnTo={currentPath(resolved)}
        userDirectory={userDirectory}
      />
    </div>
  );
}
