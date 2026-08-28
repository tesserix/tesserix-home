import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass. See
// `platform/billing/catalog/page.tsx`'s identical comment.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import { fetchKoraAiMetricsPage } from "@/lib/platform-api";
import { pagerLinks, readPage, type PagerLinks } from "../entity-page";
import type { EntityPagination } from "@/lib/entities";
import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
import { AiMetricsView } from "./ai-metrics-view";

/**
 * `/kora/ai-metrics` — the full surface behind the `/kora` overview's three
 * AI-resolution tiles. Reads the same `GET /v1/kora/ai-metrics` federation
 * part 1 added, this time paged for the per-user table and modelling
 * everything the endpoint returns rather than only the three numbers a stat
 * tile can show.
 *
 * ONE read (`fetchKoraAiMetricsPage`), decoded twice by `kora-ai-metrics.ts`
 * — the metrics and the pagination live in the same response body, so there
 * is nothing to fan out with `Promise.allSettled` the way the overview's
 * four independent tiles do.
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

export default async function KoraAiMetricsPage({
  searchParams,
}: {
  searchParams: Promise<AiMetricsSearchParams>;
}) {
  const resolved = await searchParams;
  const page = readPage(resolved);

  // Caught rather than allowed to reject: a 501 and a genuine failure are
  // both states this page renders, and an uncaught rejection would show the
  // route error boundary instead.
  let metrics: KoraAiMetrics | null = null;
  let pagination: EntityPagination = EMPTY_PAGINATION;
  let error: unknown = null;
  try {
    const result = await fetchKoraAiMetricsPage(page);
    metrics = result.metrics;
    pagination = result.pagination;
  } catch (caught: unknown) {
    error = caught;
  }

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
      />
    </div>
  );
}
