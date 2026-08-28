import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass. See
// `platform/billing/catalog/page.tsx`'s identical comment.
import {
  resolveState,
  toSurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchEstateInbox, fetchKoraAiMetrics, fetchProductEntities } from "@/lib/platform-api";
import type { EntityPage } from "@/lib/entities";
import type { EstateInbox } from "@/lib/inbox";
import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
import { KoraOverview } from "./overview-view";

/**
 * `/kora` — "is Kora OK, and what needs me?", assembled entirely from routes
 * that already exist: `kora.foods` and `kora.users`'s own `fetchProductEntities`
 * call, the estate inbox's `fetchEstateInbox`, and the one new read this task
 * adds, `fetchKoraAiMetrics`. No new platform-api module beyond that one read.
 *
 * `kora.overview` was declared `pending: true` in console-core's `routes.ts`
 * since before this console owned any Kora surface at all — a promise in the
 * rail linking nowhere. This page is what makes that promise real; `routes.ts`
 * drops `pending` in the same change.
 *
 * # FOUR independent reads, not one
 *
 * Same `Promise.allSettled` discipline `platform/billing/catalog/page.tsx`
 * and `platform/inbox/page.tsx` apply: a failure in any one read must not
 * blank the other three tiles. `overview-view.tsx`'s `KoraOverview` gives
 * each tile its own `SurfaceState` for exactly this reason.
 *
 * # Counts, not rows
 *
 * The Foods and Users tiles ask for `limit=1` — `fetchProductEntities`'s
 * fifth parameter — and read only `pagination.total`. The product's count is
 * correct regardless of how many rows were requested, so there is no reason
 * to fetch fifty rows (the product-rail index pages' page size) just to
 * discard them here.
 *
 * # The AI tile's 501 is not an error
 *
 * `/v1/kora/ai-metrics` answers 501 when this deployment does not federate
 * Kora at all (`koraaimetrics.go`'s own doc comment) — a deployment fact, the
 * same legitimate non-error state `kora.foods` and `kora.users` already
 * render for the identical reason. `resolveState` maps it to
 * `instrumentation-unavailable`, which `StatTile` renders as "Not measured"
 * rather than a red error line — never dressed up as a genuine failure, and
 * never collapsed into one either.
 */

const EMPTY_ENTITY_PAGE: EntityPage = { data: [], pagination: { page: 1, limit: 0, total: 0 } };
const EMPTY_INBOX: EstateInbox = { items: [], total: 0, failures: [] };

/**
 * The Foods/Users tiles' own page size: `1`, not `ENTITIES_LIMIT` (the
 * product-rail index pages' 50) — see the module doc comment's "Counts, not
 * rows" section. Named here, not transcribed as a bare literal at each call
 * site, so both reads visibly ask for the same thing on purpose.
 */
const COUNT_ONLY_LIMIT = 1;

async function readFoodsPage(): Promise<EntityPage> {
  return fetchProductEntities("kora", "foods", undefined, 1, COUNT_ONLY_LIMIT);
}

async function readUsersPage(): Promise<EntityPage> {
  return fetchProductEntities("kora", "users", undefined, 1, COUNT_ONLY_LIMIT);
}

async function readNeedsAttention(): Promise<EstateInbox> {
  return fetchEstateInbox("kora");
}

async function readAiMetrics(): Promise<KoraAiMetrics> {
  return fetchKoraAiMetrics();
}

/**
 * Every tile's state is decided the same way: `resolveState` over the read's
 * own rows, so `empty` (a real zero) and `error`/`instrumentation-unavailable`
 * (the read itself failed) stay the distinct states `StatTile` renders
 * differently. `filtered` is always `false` — none of these tiles has a
 * filter of its own to be narrowed by.
 */
export function tileState(caught: unknown, rows: readonly unknown[]): SurfaceState {
  return resolveState({
    isLoading: false,
    error: toSurfaceError(caught),
    rows,
    filtered: false,
  });
}

export default async function KoraOverviewPage() {
  // `allSettled`, not `all`: see the module doc comment above.
  const [foodsResult, usersResult, needsAttentionResult, aiMetricsResult] =
    await Promise.allSettled([
      readFoodsPage(),
      readUsersPage(),
      readNeedsAttention(),
      readAiMetrics(),
    ]);

  const foodsPage = foodsResult.status === "fulfilled" ? foodsResult.value : EMPTY_ENTITY_PAGE;
  const foodsError = foodsResult.status === "rejected" ? foodsResult.reason : null;
  const foodsState = tileState(foodsError, foodsPage.data);

  const usersPage = usersResult.status === "fulfilled" ? usersResult.value : EMPTY_ENTITY_PAGE;
  const usersError = usersResult.status === "rejected" ? usersResult.reason : null;
  const usersState = tileState(usersError, usersPage.data);

  const needsAttention =
    needsAttentionResult.status === "fulfilled" ? needsAttentionResult.value : EMPTY_INBOX;
  const needsAttentionError =
    needsAttentionResult.status === "rejected" ? needsAttentionResult.reason : null;
  // Rows are the inbox's own items, same as `platform/inbox/page.tsx`'s
  // `queueState` — NOT `[needsAttention]`, so an inbox that genuinely has
  // nothing waiting resolves to `empty` rather than always reading `ready`.
  const needsAttentionState = tileState(needsAttentionError, needsAttention.items);

  const aiMetrics = aiMetricsResult.status === "fulfilled" ? aiMetricsResult.value : null;
  const aiMetricsError = aiMetricsResult.status === "rejected" ? aiMetricsResult.reason : null;
  // Rows is `[aiMetrics]` when present, never `[]` on success: a window with
  // zero attempts is still a real, ready answer ("we measured, and there was
  // nothing to measure"), not an empty surface — the same distinction
  // `formatFirstTryRate` draws for the one field inside it that CAN be
  // genuinely absent.
  const aiMetricsState = tileState(aiMetricsError, aiMetrics ? [aiMetrics] : []);

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Overview"
        description="Is Kora OK, and what needs me?"
      />

      <KoraOverview
        foodsTotal={foodsState.kind === "ready" ? foodsPage.pagination.total : null}
        foodsState={foodsState}
        usersTotal={usersState.kind === "ready" ? usersPage.pagination.total : null}
        usersState={usersState}
        needsAttentionTotal={needsAttentionState.kind === "ready" ? needsAttention.total : null}
        needsAttentionState={needsAttentionState}
        aiMetrics={aiMetricsState.kind === "ready" ? aiMetrics : null}
        aiMetricsState={aiMetricsState}
        reauthReturnTo="/kora"
      />
    </div>
  );
}
