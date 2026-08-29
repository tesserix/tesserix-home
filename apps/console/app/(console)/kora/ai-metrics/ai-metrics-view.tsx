// See overview-view.tsx: `StatTile` and `SurfaceStateView` are their own
// `"use client"` components over `@tesserix/web`'s client-only barrel, so a
// server component cannot compose them as JSX. This file carries its own
// directive anyway because it also imports `formatFirstTryRate`, a value
// export of another client component.
"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { StatTile } from "@/components/kit/stat-tile";
import { ResultPager } from "@/components/kit/result-pager";
import { SurfaceStateView } from "@/components/kit/states";
// A VALUE import, deliberately: `surface-state.ts` (unlike `entities.ts` and
// `kora-ai-metrics.ts` below) carries no import of its own and never reaches
// `lib/auth/platform-token` -> `pg` — see that module's own doc comment. It
// is the pure half of the kit built exactly so both server AND client
// components can call `resolveState` directly.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
// `import type` only for both of these — see the module doc comment on
// `page.tsx` and `overview-view.tsx`'s identical warning. `entities.ts` and
// `kora-ai-metrics.ts` are both reachable from server-only modules
// (`lib/platform-api.ts` -> `lib/auth/platform-token` -> `pg`), and a client
// component importing a VALUE from either would drag that chain into the
// browser bundle.
import type { EntityPagination, EntityRecord } from "@/lib/entities";
import type { KoraAiMetrics, KoraAiUser } from "@/lib/kora-ai-metrics";
import type { PagerLinks } from "../entity-page";
// The ONE place `first_try_rate_pct` becomes copy — reused here rather than
// re-derived, per the plan's explicit instruction. Both surfaces share the
// exact same non-negotiable: absent must never render as 0%.
import { formatFirstTryRate } from "../overview-view";

/** `id -> EntityRecord`, one page of kora users — see `page.tsx`'s
 *  `buildUserDirectory`, which is the only place this is built. */
export type UserDirectory = ReadonlyMap<string, EntityRecord>;

// Hardcoded rather than imported from `../users/page`: that module is a
// server component pulling `fetchProductEntities` (a value import reaching
// `lib/auth/platform-token` -> `pg`), and this file must not acquire that
// chain — see the `import type` note above. `users/page.tsx`'s own
// `USER_PATH` is the same literal; keep the two in sync by eye.
const USERS_PATH = "/kora/users";

/** Where an operator goes to find this person — the search box on
 *  `/kora/users` narrows by the same id/label Kora sent, matched or not. A
 *  user this table cannot name is exactly the case an operator most needs
 *  the link for. */
function userHref(userId: string): string {
  return `${USERS_PATH}?q=${encodeURIComponent(userId)}`;
}

/**
 * The full `/kora/ai-metrics` surface — the destination behind the
 * overview's three AI-resolution tiles. Renders everything the endpoint
 * returns beyond those three headline numbers: the measurement window, every
 * kind Kora scored (zero-filled, all of them shown), and the paginated
 * per-user table.
 */

export interface AiMetricsViewProps {
  /** `null` only when `state.kind !== "ready"` — see `page.tsx`'s `aiMetricsState`. */
  metrics: KoraAiMetrics | null;
  pager: PagerLinks;
  pagination: EntityPagination;
  state: SurfaceState;
  reauthReturnTo: string;
  /** One page of kora users, keyed by id — see `page.tsx`'s
   *  `buildUserDirectory`. Only ids inside that one fetched page can be
   *  named; an id not in this map renders as the raw id, never a
   *  placeholder — see `userCell`. */
  userDirectory: UserDirectory;
}

/**
 * A `by_kind` label for display: Kora's own vocabulary, underscore-to-space
 * swapped for readability and reversible by eye — the same presentation-only
 * transform `inbox-queue.tsx`'s `kindLabel` applies, and for the same reason:
 * this is the PRODUCT's word, not a console-invented one.
 */
function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

/**
 * The per-user filters this surface offers.
 *
 * Only the fields that exist on `KoraAiUser` become activity toggles —
 * `hasCorrections`, `hasBudgetRefusals`, `hasAiCalls`. There is deliberately
 * no "needs human" toggle: that is an aggregate on `outcomes`, computed
 * across every user, not a field any one user row carries.
 *
 * `q` matches the joined name/email AND the raw id (see `matchesUserFilter`)
 * so a UUID pasted from elsewhere still finds its row even when the join
 * could not name it.
 */
export const USER_FILTER_DESCRIPTORS: FilterDescriptor[] = [
  { key: "q", label: "Search this page's users", type: "search" },
  {
    key: "hasCorrections",
    label: "Corrections",
    type: "select",
    options: [{ value: "yes", label: "Has corrections" }],
  },
  {
    key: "hasBudgetRefusals",
    label: "Budget refusals",
    type: "select",
    options: [{ value: "yes", label: "Has budget refusals" }],
  },
  {
    key: "hasAiCalls",
    label: "AI calls",
    type: "select",
    options: [{ value: "yes", label: "Has AI calls" }],
  },
];

/** True when any of `USER_FILTER_DESCRIPTORS` is active. This is the switch
 *  between the true cross-page total (`ResultPager`) and a page-scoped count
 *  — see the "Users" section's render, and the plan's honesty requirement:
 *  a filtered list must never sit beside a total that still counts every
 *  page kora's `ai-metrics` endpoint has no server-side search or filter for. */
export function userFiltersActive(values: FilterValues): boolean {
  return USER_FILTER_DESCRIPTORS.some((descriptor) => (values[descriptor.key] ?? "") !== "");
}

/**
 * Whether one user row matches the active filters.
 *
 * `q` is checked against the raw id AND, where the join found one, the
 * entity's `label`/`sublabel` — kora's contract note (part C's plan) is
 * explicit that a pasted UUID must still find its row even once a name is
 * showing, so the id is never dropped from the haystack just because a name
 * was joined in.
 */
export function matchesUserFilter(
  user: KoraAiUser,
  entity: EntityRecord | undefined,
  values: FilterValues,
): boolean {
  const q = (values.q ?? "").trim().toLowerCase();
  if (q !== "") {
    const haystack = [user.userId, entity?.label, entity?.sublabel].filter(
      (value): value is string => typeof value === "string",
    );
    if (!haystack.some((value) => value.toLowerCase().includes(q))) {
      return false;
    }
  }
  if ((values.hasCorrections ?? "") === "yes" && user.corrections <= 0) return false;
  if ((values.hasBudgetRefusals ?? "") === "yes" && user.budgetRefusals <= 0) return false;
  if ((values.hasAiCalls ?? "") === "yes" && user.aiCalls <= 0) return false;
  return true;
}

/**
 * A user's cell in the table: the joined name where the id was found in
 * `userDirectory`, the raw id where it was not.
 *
 * The raw id is NOT a fallback of last resort dressed up as an error — it is
 * the honest answer when the join can only cover one fetched page of users.
 * "Outside the fetched page" and "does not exist" are different facts, and a
 * placeholder like "Unknown user" would render them identically. Same rule
 * `formatFirstTryRate` and the `lastActivityAt` cell already apply on this
 * surface: absence renders as absence, never as an invented certainty.
 */
function userCell(userId: string, userDirectory: UserDirectory) {
  const entity = userDirectory.get(userId);
  if (!entity) {
    return (
      <Link
        href={userHref(userId)}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {userId}
      </Link>
    );
  }
  return (
    <Link href={userHref(userId)} className="hover:underline">
      <div>{entity.label}</div>
      {/* Rendered only when present — see `EntityRecord.sublabel`'s doc
          comment. A placeholder here would make "Kora sent no sublabel" look
          like "this user has no handle", which `user-directory.tsx` already
          takes care not to do. */}
      {entity.sublabel ? (
        <div className="text-xs text-muted-foreground">{entity.sublabel}</div>
      ) : null}
    </Link>
  );
}

export function AiMetricsView({
  metrics,
  pager,
  pagination,
  state,
  reauthReturnTo,
  userDirectory,
}: AiMetricsViewProps) {
  // Called unconditionally, ahead of the early return below — hooks cannot
  // be conditional, and `metrics` is null exactly when this hook's result
  // goes unused (the early return renders `SurfaceStateView` instead).
  const { values: userFilterValues, set: setUserFilter, clear: clearUserFilters } =
    useUrlFilters(USER_FILTER_DESCRIPTORS);

  if (state.kind !== "ready" || !metrics) {
    return (
      <SurfaceStateView
        state={state}
        emptyMessage="Kora has not measured anything yet."
        reauthReturnTo={reauthReturnTo}
      />
    );
  }

  // `Object.entries`, not a fixed list of kind names — see the module doc
  // comment on `kora-ai-metrics.ts`. Every key Kora sent is rendered,
  // including one whose count is zero: dropping it would hide that Kora
  // measured that kind and found none, a different fact from not measuring
  // it at all.
  const byKindEntries = Object.entries(metrics.outcomes.byKind);

  const filtersActive = userFiltersActive(userFilterValues);
  const filteredUsers = metrics.users.filter((user) =>
    matchesUserFilter(user, userDirectory.get(user.userId), userFilterValues),
  );
  // `filtered: filtersActive` is what makes an empty MATCH read as "no
  // results — clear filters" (`filtered-empty`) rather than the plain
  // "nothing here" copy `empty` carries — the distinction `resolveState`
  // exists for. `filteredUsers` can only be empty here when a filter is
  // active: `metrics.users.length === 0` is handled by its own branch below,
  // before this is ever computed.
  const usersSectionState = resolveState({
    isLoading: false,
    error: null,
    rows: filteredUsers,
    filtered: filtersActive,
  });

  return (
    <div className="flex flex-col gap-6">
      {/* The window is a real datum, not chrome — a reader must know what
          period the numbers below it cover. */}
      <p className="text-sm text-muted-foreground">
        Window: <time dateTime={metrics.window.from}>{metrics.window.from}</time>
        {" – "}
        <time dateTime={metrics.window.to}>{metrics.window.to}</time>
      </p>

      <section className="flex flex-col gap-3" aria-label="Outcomes">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile label="Resolution attempts" value={metrics.outcomes.attempts} />
          <StatTile label="Needs human" value={metrics.outcomes.needsHuman} />
          <StatTile
            label="First-try rate"
            value={formatFirstTryRate(metrics.outcomes.firstTryRatePct)}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="Outcomes by kind">
        <h3 className="text-sm font-medium">By kind</h3>
        {byKindEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Kora measured no kinds this window.</p>
        ) : (
          <Table aria-label="Outcomes by kind">
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byKindEntries.map(([kind, count]) => (
                <TableRow key={kind}>
                  <TableCell>{kindLabel(kind)}</TableCell>
                  <TableCell className="tabular-nums">{count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Users">
        <h3 className="text-sm font-medium">Users</h3>
        {metrics.users.length === 0 ? (
          // An empty page of users is not a reason to blank the outcomes
          // above it — the read succeeded, this window just has none. No
          // filter can narrow zero rows, so the filter bar has nothing to do
          // here.
          <p className="text-sm text-muted-foreground">No users in this window.</p>
        ) : (
          <>
            <FilterBar
              descriptors={USER_FILTER_DESCRIPTORS}
              values={userFilterValues}
              onChange={setUserFilter}
              onClear={clearUserFilters}
            />
            {/* The page-scoped limitation, stated in the UI rather than left
                for a comment nobody reading the page will see: kora's
                `ai-metrics` endpoint takes only `from`/`to`/`page`/`limit`,
                so these filters can only narrow the page already fetched. */}
            <p className="text-xs text-muted-foreground">
              These filters search only the {metrics.users.length} users on this page — kora has
              no server-side search here, so use the pager to reach the rest.
            </p>
            {usersSectionState.kind === "ready" ? (
              <>
                {filtersActive ? (
                  // NEVER the cross-page `pagination.total` beside a filtered
                  // list — that total counts every page, unfiltered, and
                  // pairing it with a narrowed list is the exact defect this
                  // surface exists to avoid (see the plan's "short queue"
                  // trap). A page-scoped count instead.
                  <p aria-live="polite" className="text-sm text-muted-foreground">
                    {filteredUsers.length} of {metrics.users.length} on this page match these
                    filters.
                  </p>
                ) : (
                  <ResultPager
                    label="users"
                    count={metrics.users.length}
                    total={pagination.total}
                    precedingCount={pager.precedingCount}
                    nextHref={pager.nextHref}
                    previousHref={pager.previousHref}
                  />
                )}
                <Table aria-label="Kora AI users">
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Resolves</TableHead>
                      <TableHead>Corrections</TableHead>
                      <TableHead>Budget refusals</TableHead>
                      <TableHead>AI calls</TableHead>
                      <TableHead>Last activity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.map((user) => (
                      <TableRow key={user.userId}>
                        <TableCell className="font-medium">
                          {userCell(user.userId, userDirectory)}
                        </TableCell>
                        <TableCell className="tabular-nums">{user.attempts}</TableCell>
                        <TableCell className="tabular-nums">{user.resolves}</TableCell>
                        <TableCell className="tabular-nums">{user.corrections}</TableCell>
                        <TableCell className="tabular-nums">{user.budgetRefusals}</TableCell>
                        <TableCell className="tabular-nums">{user.aiCalls}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {/* Optional in the same way `first_try_rate_pct`
                              is: absence is rendered as absence, never as
                              "Never" or an invented instant. */}
                          {user.lastActivityAt ? (
                            <time dateTime={user.lastActivityAt}>{user.lastActivityAt}</time>
                          ) : (
                            <span aria-hidden="true">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <SurfaceStateView
                state={usersSectionState}
                emptyMessage="No users match these filters."
                onClearFilters={clearUserFilters}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
